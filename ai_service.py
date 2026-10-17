"""Local YOLO face detection and SFace embedding worker for Tashrif CRM."""

import base64
import json
import os
import re
import sys

import cv2
import numpy as np


MODEL_DIR = os.environ.get("TASHRIF_AI_MODEL_DIR", "")
YOLO_PATH = os.path.join(MODEL_DIR, "yolov8n-face-lindevs.onnx")
YUNET_PATH = os.path.join(MODEL_DIR, "face_detection_yunet_2023mar.onnx")
SFACE_PATH = os.path.join(MODEL_DIR, "face_recognition_sface_2021dec.onnx")
MIN_FACE_SIZE = int(os.environ.get("TASHRIF_MIN_FACE_SIZE", "72"))
MAX_IMAGE_DIMENSION = 4096
MAX_IMAGE_PIXELS = 12_000_000
JPEG_SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
# Normalized distance from frame center (0=center, 1=frame corner).
# A tablet camera has no depth sensor, so face size and a center zone are
# used as a practical proxy for selecting the closest person.
FACE_CENTER_RADIUS = float(os.environ.get("TASHRIF_FACE_CENTER_RADIUS", "0.62"))


def load_models():
    for model_path in (YOLO_PATH, YUNET_PATH, SFACE_PATH):
        if not os.path.isfile(model_path):
            raise RuntimeError("AI modeli topilmadi: " + os.path.basename(model_path))
    detector = cv2.dnn.readNetFromONNX(YOLO_PATH)
    landmarks = cv2.FaceDetectorYN.create(YUNET_PATH, "", (320, 320), 0.85, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(SFACE_PATH, "")
    return detector, landmarks, recognizer


def decode_image(data_url):
    match = re.fullmatch(r"data:image/jpeg;base64,([A-Za-z0-9+/=]+)", str(data_url or ""))
    if not match:
        raise ValueError("Kamera tasvirini JPEG formatida yuboring.")
    raw = base64.b64decode(match.group(1), validate=True)
    if len(raw) < 4 or len(raw) > 2 * 1024 * 1024:
        raise ValueError("Kamera tasviri 2 MB dan kichik bo‘lishi kerak.")
    dimensions = jpeg_dimensions(raw)
    if dimensions:
        width, height = dimensions
        if width <= 0 or height <= 0 or max(width, height) > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
            raise ValueError("Kamera tasviri o‘lchami juda katta.")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ValueError("Kamera tasvirini o‘qib bo‘lmadi.")
    height, width = image.shape[:2]
    if max(width, height) > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("Kamera tasviri o‘lchami juda katta.")
    return image


def jpeg_dimensions(raw):
    """Read JPEG dimensions before decoding so oversized images are rejected early."""
    if not raw.startswith(b"\xff\xd8"):
        return None
    index = 2
    while index < len(raw):
        if raw[index] != 0xFF:
            index += 1
            continue
        while index < len(raw) and raw[index] == 0xFF:
            index += 1
        if index >= len(raw):
            break
        marker = raw[index]
        index += 1
        if marker in {0xD8, 0xD9, 0x01} or 0xD0 <= marker <= 0xD7:
            continue
        if index + 2 > len(raw):
            break
        segment_length = int.from_bytes(raw[index:index + 2], "big")
        if segment_length < 2 or index + segment_length > len(raw):
            break
        if marker in JPEG_SOF_MARKERS and segment_length >= 8:
            height = int.from_bytes(raw[index + 3:index + 5], "big")
            width = int.from_bytes(raw[index + 5:index + 7], "big")
            return width, height
        if marker == 0xDA:
            break
        index += segment_length
    return None


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    return intersection / max(1e-6, area_a + area_b - intersection)


def select_nearest_face(faces, width, height):
    """Pick the largest usable face in the configured central camera zone."""
    diagonal_radius = max(1.0, 0.5 * float(np.hypot(width, height)))
    candidates = []
    for face in faces:
        x1, y1, x2, y2 = face["box"]
        box_width, box_height = x2 - x1, y2 - y1
        if min(box_width, box_height) < MIN_FACE_SIZE:
            continue
        center_x, center_y = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        distance = float(np.hypot(center_x - width / 2.0, center_y - height / 2.0) / diagonal_radius)
        if distance > FACE_CENTER_RADIUS:
            continue
        area = box_width * box_height
        # Face size is the main proximity signal; center distance breaks close ties.
        candidates.append((area * (1.0 - 0.18 * distance), face))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def detect_yolo(detector, image):
    height, width = image.shape[:2]
    side = max(height, width)
    square = np.zeros((side, side, 3), dtype=np.uint8)
    square[:height, :width] = image
    blob = cv2.dnn.blobFromImage(square, 1 / 255.0, (640, 640), swapRB=True, crop=False)
    detector.setInput(blob)
    output = detector.forward()
    rows = np.asarray(output[0] if isinstance(output, (list, tuple)) else output)
    if rows.ndim == 3:
        rows = rows[0]
    if rows.ndim != 2:
        raise RuntimeError("YOLO modelining chiqish formati kutilganidek emas.")
    if rows.shape[0] < rows.shape[1] and rows.shape[0] <= 32:
        rows = rows.T
    if rows.shape[1] < 5:
        raise RuntimeError("YOLO modelida yuz ishonchliligi topilmadi.")

    boxes, scores = [], []
    scale = side / 640.0
    for row in rows:
        score = float(row[4])
        if score < 0.55:
            continue
        cx, cy, box_w, box_h = (float(v) for v in row[:4])
        x1 = max(0.0, min(float(width), (cx - box_w / 2) * scale))
        y1 = max(0.0, min(float(height), (cy - box_h / 2) * scale))
        x2 = max(0.0, min(float(width), (cx + box_w / 2) * scale))
        y2 = max(0.0, min(float(height), (cy + box_h / 2) * scale))
        if x2 - x1 >= 32 and y2 - y1 >= 32:
            boxes.append([int(x1), int(y1), int(x2 - x1), int(y2 - y1)])
            scores.append(score)
    if not boxes:
        return []
    kept = cv2.dnn.NMSBoxes(boxes, scores, 0.55, 0.45)
    indexes = np.asarray(kept).reshape(-1).tolist() if len(kept) else []
    return [
        {
            "box": [boxes[i][0], boxes[i][1], boxes[i][0] + boxes[i][2], boxes[i][1] + boxes[i][3]],
            "confidence": scores[i],
        }
        for i in indexes
    ]


def analyze(data_url, models):
    detector, landmarks, recognizer = models
    image = decode_image(data_url)
    yolo_faces = detect_yolo(detector, image)
    if not yolo_faces:
        return {"ok": False, "code": "no_face", "error": "YOLO yuzni aniqlamadi. Kameraga to‘g‘ri qarab, yaqinroq turing."}
    height, width = image.shape[:2]
    yolo_face = select_nearest_face(yolo_faces, width, height)
    if yolo_face is None:
        return {"ok": False, "code": "face_out_of_zone", "error": "Kadr markazidagi ish zonasiga yaqinroq turing; orqa fondagi yuzlar tanlanmaydi."}
    x1, y1, x2, y2 = yolo_face["box"]

    landmarks.setInputSize((width, height))
    _, faces = landmarks.detect(image)
    if faces is None or len(faces) == 0:
        return {"ok": False, "code": "landmarks_missing", "error": "Yuz nuqtalari topilmadi. Yorug‘ joyda qayta urinib ko‘ring."}
    matched = []
    for face in faces:
        fx, fy, fw, fh = (float(v) for v in face[:4])
        score = iou(yolo_face["box"], [fx, fy, fx + fw, fy + fh])
        matched.append((score, face))
    overlap, face = max(matched, key=lambda item: item[0])
    if overlap < 0.2:
        return {"ok": False, "code": "face_alignment_failed", "error": "Yuzni moslab bo‘lmadi. Kameraga to‘g‘ri qarab qayta turing."}

    aligned = recognizer.alignCrop(image, face)
    feature = np.asarray(recognizer.feature(aligned), dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(feature))
    if not np.isfinite(norm) or norm < 1e-6:
        return {"ok": False, "code": "embedding_failed", "error": "Yuz shablonini hisoblab bo‘lmadi."}
    feature = feature / norm
    return {
        "ok": True,
        "embedding": [round(float(v), 7) for v in feature],
        "faceConfidence": round(float(yolo_face["confidence"]), 4),
        "imageSize": [width, height],
    }


def main():
    try:
        models = load_models()
    except Exception as error:
        print(json.dumps({"event": "error", "error": str(error)}, ensure_ascii=False), flush=True)
        return 2
    print(json.dumps({"event": "ready", "engine": "YOLOv8-Face + SFace"}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = analyze(request.get("imageDataUrl"), models)
            result["id"] = request.get("id")
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id") if "request" in locals() else None, "ok": False, "code": "inference_error", "error": str(error)}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
