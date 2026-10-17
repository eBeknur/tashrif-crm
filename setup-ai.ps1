$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$dataPath = Join-Path $PSScriptRoot '.tashrif-data'
$modelPath = Join-Path $dataPath 'ai-models'
$venvPath = Join-Path $dataPath 'ai-venv'
New-Item -ItemType Directory -Path $modelPath -Force | Out-Null

$python = $null
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCommand -and $pythonCommand.Source -notmatch '\\WindowsApps\\') {
    $python = $pythonCommand.Source
}
if (-not $python) {
    $candidate = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $candidate) { $python = $candidate }
}
if (-not $python) {
    throw "AI uchun Python 3.10–3.12 kerak. Python o‘rnating va setup-ai.ps1 ni qayta ishga tushiring."
}

$venvPython = Join-Path $venvPath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    & $python -m venv $venvPath
    if ($LASTEXITCODE -ne 0) { throw 'AI Python muhiti yaratilmadi.' }
}
& $venvPython -m pip install --disable-pip-version-check --no-warn-script-location 'numpy==1.26.4' 'opencv-contrib-python-headless==4.10.0.84'
if ($LASTEXITCODE -ne 0) { throw "YOLO uchun OpenCV kutubxonalarini o‘rnatib bo‘lmadi." }

$models = @(
    @{ Name='yolov8n-face-lindevs.onnx'; Url='https://github.com/lindevs/yolov8-face/releases/latest/download/yolov8n-face-lindevs.onnx'; Sha256='8d0bfb0c3383c5bd7a78dd24ef79a21e2aa456619b6ab5e53867092d1c7dc414'; MinBytes=10000000 },
    @{ Name='face_recognition_sface_2021dec.onnx'; Url='https://huggingface.co/opencv/opencv_zoo/resolve/d4938dfc9d4ec5d098bfa33e98b3f3345a236586/models/face_recognition_sface/face_recognition_sface_2021dec.onnx'; Sha256='0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'; MinBytes=30000000 },
    @{ Name='face_detection_yunet_2023mar.onnx'; Url='https://huggingface.co/opencv/opencv_zoo/resolve/d4938dfc9d4ec5d098bfa33e98b3f3345a236586/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'; Sha256='8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'; MinBytes=100000 }
)
foreach ($model in $models) {
    $target = Join-Path $modelPath $model.Name
    if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -ge $model.MinBytes) {
        if ($model.Sha256) {
            $existingHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($existingHash -eq $model.Sha256) { continue }
            Remove-Item -LiteralPath $target -Force
        } else { continue }
    }
    $partial = "$target.download"
    Write-Host "AI modeli yuklanmoqda: $($model.Name)" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $model.Url -OutFile $partial -TimeoutSec 180
    if ((Get-Item -LiteralPath $partial).Length -lt $model.MinBytes) { Remove-Item -LiteralPath $partial -Force; throw "Model fayli to‘liq yuklanmadi: $($model.Name)" }
    if ($model.Sha256) {
        $actualHash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $model.Sha256) { Remove-Item -LiteralPath $partial -Force; throw "Model SHA-256 tekshiruvidan o‘tmadi: $($model.Name)" }
    }
    Move-Item -LiteralPath $partial -Destination $target -Force
}

$pythonRecord = Join-Path $dataPath 'ai-python.txt'
[System.IO.File]::WriteAllText($pythonRecord, $venvPython, [System.Text.UTF8Encoding]::new($false))
& $venvPython -c "import cv2, numpy; print('OpenCV', cv2.__version__, '| NumPy', numpy.__version__)"
if ($LASTEXITCODE -ne 0) { throw "AI kutubxonalarini tekshirib bo‘lmadi." }
Write-Host 'YOLO va yuzni taqqoslash modellari tayyor.' -ForegroundColor Green
