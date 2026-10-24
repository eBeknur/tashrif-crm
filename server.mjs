import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.TASHRIF_DATA_DIR || path.join(ROOT, '.tashrif-data'));
const PORT = Number(process.env.PORT || 8000);
const TLS_PORT = Number(process.env.TLS_PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 3 * 1024 * 1024;
fs.mkdirSync(path.join(DATA, 'photos'), { recursive: true });
const caPath = path.join(DATA, 'tashrif-local-ca.cer');
const tlsPfxPath = path.join(DATA, 'https-server.pfx');
const tlsPasswordPath = path.join(DATA, 'https-password.txt');
const tlsConfig = fs.existsSync(tlsPfxPath) && fs.existsSync(tlsPasswordPath)
  ? { pfx: fs.readFileSync(tlsPfxPath), passphrase: fs.readFileSync(tlsPasswordPath, 'utf8').trim(), minVersion: 'TLSv1.2' }
  : null;

const keyPath = path.join(DATA, 'storage.key');
let storageKey;
try { storageKey = fs.readFileSync(keyPath); }
catch {
  storageKey = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, storageKey, { flag: 'wx', mode: 0o600 });
}
if (storageKey.length !== 32) throw new Error('storage.key must contain 32 bytes');

const db = new DatabaseSync(path.join(DATA, 'tashrif.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
    direction TEXT NOT NULL DEFAULT 'entry' CHECK (direction IN ('entry','exit','both'))
  );
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY, employee_code TEXT UNIQUE, name TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    face_template TEXT
  );
  CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, organization TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL, arrived_at TEXT NOT NULL, departed_at TEXT,
    photo_saved INTEGER NOT NULL CHECK (photo_saved IN (0,1)), photo_file TEXT,
    method TEXT NOT NULL DEFAULT 'Planshet', face_template TEXT
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
    action TEXT NOT NULL, record_id TEXT, created_at TEXT NOT NULL
  );
`);
const visitColumns = new Set(db.prepare('PRAGMA table_info(visits)').all().map(column => column.name));
if (visitColumns.has('consent') && !visitColumns.has('photo_saved')) db.exec('ALTER TABLE visits RENAME COLUMN consent TO photo_saved');
const deviceColumns = new Set(db.prepare('PRAGMA table_info(devices)').all().map(column => column.name));
if (!deviceColumns.has('direction')) db.exec("ALTER TABLE devices ADD COLUMN direction TEXT NOT NULL DEFAULT 'entry'");
for (const migration of [
  'ALTER TABLE employees ADD COLUMN face_template TEXT',
  'ALTER TABLE visits ADD COLUMN face_template TEXT',
]) {
  try { db.exec(migration); } catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }
}

const q = {
  adminCount: db.prepare('SELECT COUNT(*) AS n FROM admins'),
  adminByUsername: db.prepare('SELECT * FROM admins WHERE username = ?'),
  insertAdmin: db.prepare('INSERT INTO admins VALUES (?, ?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?)'),
  session: db.prepare('SELECT admins.id, admins.username, sessions.expires_at FROM sessions JOIN admins ON admins.id=sessions.admin_id WHERE sessions.id_hash=?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id_hash=?'),
  deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  devices: db.prepare('SELECT id, name, direction, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM devices ORDER BY created_at DESC'),
  deviceByHash: db.prepare('SELECT id, name, direction, revoked_at FROM devices WHERE token_hash=?'),
  insertDevice: db.prepare('INSERT INTO devices (id,name,token_hash,created_at,direction) VALUES (?,?,?,?,?)'),
  revokeDevice: db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL'),
  pingDevice: db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?'),
  visits: db.prepare('SELECT id, name, organization, purpose, arrived_at AS arrived, departed_at AS departed, photo_saved AS photoSaved, photo_file AS photoFile, method FROM visits ORDER BY arrived_at DESC'),
  activeVisits: db.prepare('SELECT id, name, organization, purpose, arrived_at AS arrived FROM visits WHERE departed_at IS NULL ORDER BY arrived_at'),
  insertVisit: db.prepare('INSERT INTO visits (id,name,organization,purpose,arrived_at,photo_saved,photo_file,method,face_template) VALUES (?,?,?,?,?,?,?,?,?)'),
  checkout: db.prepare('UPDATE visits SET departed_at=?, face_template=NULL WHERE id=? AND departed_at IS NULL'),
  employees: db.prepare('SELECT id, employee_code AS employeeCode, name, department, created_at AS createdAt, face_template IS NOT NULL AS hasFaceTemplate FROM employees ORDER BY name'),
  insertEmployee: db.prepare('INSERT INTO employees (id,employee_code,name,department,created_at) VALUES (?,?,?,?,?)'),
  employeeTemplates: db.prepare('SELECT id, employee_code AS employeeCode, name, face_template AS faceTemplate FROM employees WHERE face_template IS NOT NULL'),
  setEmployeeTemplate: db.prepare('UPDATE employees SET face_template=? WHERE id=?'),
  deleteEmployeeTemplate: db.prepare('UPDATE employees SET face_template=NULL WHERE id=?'),
  activeFaceVisits: db.prepare('SELECT id, name, organization, arrived_at AS arrived, face_template AS faceTemplate FROM visits WHERE departed_at IS NULL AND photo_saved=1 AND face_template IS NOT NULL'),
  audit: db.prepare('INSERT INTO audit (actor,action,record_id,created_at) VALUES (?,?,?,?)'),
  photo: db.prepare('SELECT photo_file FROM visits WHERE id=? AND photo_file IS NOT NULL'),
};

const loginAttempts = new Map();
const now = () => new Date().toISOString();
const id = prefix => `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function audit(actor, action, recordId = null) { q.audit.run(actor, action, recordId, now()); }
function protect(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', storageKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value ?? ''), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}
function reveal(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value || '';
  const [, , ivText, tagText, encryptedText] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}
function employeeList() {
  return q.employees.all().map(e => ({ ...e, name: reveal(e.name), department: reveal(e.department), hasFaceTemplate: Boolean(e.hasFaceTemplate) })).sort((a,b) => a.name.localeCompare(b.name, 'uz'));
}
function headers(res, type = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}
function send(res, status, data, type) {
  headers(res, type);
  res.statusCode = status;
  if (type && !type.startsWith('application/json')) return res.end(data);
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { send(res, status, { error: message }); }
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
  }));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('So‘rov hajmi 3 MB dan oshdi.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON formatidagi so‘rov yuboring.'), { status: 400 }); }
}
function clean(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function session(req) {
  const raw = cookies(req).sid;
  if (!raw) return null;
  const row = q.session.get(digest(raw));
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}
function adminOnly(req, res) {
  const s = session(req);
  if (!s) { fail(res, 401, 'Administrator sifatida tizimga kiring.'); return null; }
  return s;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    const protocol = req.socket.encrypted ? 'https:' : 'http:';
    return parsed.host === req.headers.host && parsed.protocol === protocol && parsed.origin === origin;
  } catch { return false; }
}
function isLoopback(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }
function adminMutation(req, res) {
  if (!sameOrigin(req)) { fail(res, 403, 'Manba tekshiruvidan o‘tmadi.'); return null; }
  return adminOnly(req, res);
}
function deviceOnly(req, res) {
  const token = req.headers['x-device-token'];
  if (typeof token !== 'string' || token.length < 32) { fail(res, 401, 'Terminal tokeni noto‘g‘ri.'); return null; }
  const row = q.deviceByHash.get(digest(token));
  if (!row || row.revoked_at) { fail(res, 401, 'Terminal tokeni bekor qilingan yoki topilmadi.'); return null; }
  q.pingDevice.run(now(), row.id);
  return row;
}
function storePhoto(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('JPEG suratni tanlang.'), { status: 400 });
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length < 4 || raw.length > 2 * 1024 * 1024 || raw[0] !== 0xff || raw[1] !== 0xd8 || raw[2] !== 0xff) {
    throw Object.assign(new Error('JPEG surat 2 MB dan kichik bo‘lishi kerak.'), { status: 400 });
  }
  const filename = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(DATA, 'photos', filename), raw, { flag: 'wx', mode: 0o600 });
  return filename;
}
function readPhoto(filename) {
  if (!filename || path.basename(filename) !== filename) throw new Error('Surat topilmadi.');
  const bytes = fs.readFileSync(path.join(DATA, 'photos', filename));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return bytes;
  // Avvalgi MVP versiyasida AES-GCM bilan yozilgan suratlarni ham ochib ko‘rsatamiz.
  const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}
function migrateLegacyPhotos() {
  const oldPhotos = db.prepare("SELECT id, photo_file AS photoFile FROM visits WHERE photo_file LIKE '%.enc'").all();
  const updatePhoto = db.prepare('UPDATE visits SET photo_file=? WHERE id=?');
  for (const row of oldPhotos) {
    const source = path.join(DATA, 'photos', row.photoFile);
    const raw = readPhoto(row.photoFile);
    if (raw[0] !== 0xff || raw[1] !== 0xd8 || raw[2] !== 0xff) throw new Error(`Legacy tashrif surati JPEG emas: ${row.photoFile}`);
    const filename = `${crypto.randomUUID()}.jpg`;
    const target = path.join(DATA, 'photos', filename);
    fs.writeFileSync(target, raw, { flag: 'wx', mode: 0o600 });
    updatePhoto.run(filename, row.id);
    fs.unlinkSync(source);
  }
}
migrateLegacyPhotos();
function oneTimeToken() { return `tsh_${crypto.randomBytes(32).toString('base64url')}`; }
function localUrls() {
  const urls = new Set();
  for (const entries of Object.values(os.networkInterfaces())) for (const n of entries || []) {
    if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')) urls.add(`${tlsConfig ? 'https' : 'http'}://${n.address}:${tlsConfig ? TLS_PORT : PORT}`);
  }
  return [...urls];
}
function setSession(res, req, raw) {
  const secure = req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(raw)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); }
function listVisits() { return q.visits.all().map(v => ({ ...v, name: reveal(v.name), organization: reveal(v.organization), purpose: reveal(v.purpose), photoSaved: Boolean(v.photoSaved), photoAvailable: Boolean(v.photoFile), photoFile: undefined })); }
function activeVisits() { return q.activeVisits.all().map(v => ({ ...v, name: reveal(v.name), organization: reveal(v.organization), purpose: reveal(v.purpose) })); }

let aiWorker = null;
let aiReady = false;
let aiRequestId = 0;
let aiState = { status: 'not-installed', engine: 'YOLOv8-Face + SFace' };
const aiPending = new Map();
const faceTickets = new Map();
const ticketCleanup = setInterval(() => {
  const timestamp = Date.now();
  for (const [ticket, value] of faceTickets) if (value.expiresAt <= timestamp) faceTickets.delete(ticket);
}, 30000);
ticketCleanup.unref();

function startAiWorker() {
  const pythonPathFile = path.join(DATA, 'ai-python.txt');
  const modelDir = path.join(DATA, 'ai-models');
  if (!fs.existsSync(pythonPathFile) || !fs.existsSync(path.join(modelDir, 'yolov8n-face-lindevs.onnx')) || !fs.existsSync(path.join(modelDir, 'face_recognition_sface_2021dec.onnx')) || !fs.existsSync(path.join(modelDir, 'face_detection_yunet_2023mar.onnx'))) return;
  const pythonPath = fs.readFileSync(pythonPathFile, 'utf8').trim();
  if (!pythonPath || !fs.existsSync(pythonPath)) { aiState = { status: 'python-missing', engine: 'YOLOv8-Face + SFace' }; return; }
  aiState = { status: 'starting', engine: 'YOLOv8-Face + SFace' };
  aiWorker = spawn(pythonPath, ['-u', path.join(ROOT, 'ai_service.py')], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TASHRIF_AI_MODEL_DIR: modelDir },
  });
  const lines = readline.createInterface({ input: aiWorker.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { console.error('AI worker javobi o‘qilmadi.'); return; }
    if (message.event === 'ready') {
      aiReady = true;
      aiState = { status: 'ready', engine: message.engine || 'YOLOv8-Face + SFace' };
      console.log(`AI tayyor: ${aiState.engine}`);
      return;
    }
    if (message.event === 'error') {
      aiReady = false;
      aiState = { status: 'error', engine: 'YOLOv8-Face + SFace', error: clean(message.error, 240) };
      console.error(`AI ishga tushmadi: ${aiState.error}`);
      return;
    }
    const pending = aiPending.get(message.id);
    if (pending) {
      clearTimeout(pending.timeout);
      aiPending.delete(message.id);
      pending.resolve(message);
    }
  });
  aiWorker.stderr.on('data', data => console.error(`AI: ${String(data).trim()}`));
  aiWorker.on('error', error => {
    aiReady = false;
    aiState = { status: 'error', engine: 'YOLOv8-Face + SFace', error: clean(error.message, 240) };
  });
  aiWorker.on('exit', code => {
    aiReady = false;
    if (aiState.status !== 'error') aiState = { status: 'stopped', engine: 'YOLOv8-Face + SFace' };
    for (const pending of aiPending.values()) { clearTimeout(pending.timeout); pending.reject(Object.assign(new Error('AI xizmati to‘xtadi.'), { status: 503 })); }
    aiPending.clear();
    if (code && code !== 0) console.error(`AI worker yakunlandi (kod ${code}).`);
    aiWorker = null;
  });
}

function analyzeFace(imageDataUrl, op = 'analyze') {
  if (!aiReady || !aiWorker) return Promise.reject(Object.assign(new Error('YOLO xizmati tayyor emas. Serverda setup-ai.ps1 ni ishga tushiring.'), { status: 503 }));
  const requestId = String(++aiRequestId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      aiPending.delete(requestId);
      reject(Object.assign(new Error('Yuzni aniqlash vaqti tugadi. Qayta urinib ko‘ring.'), { status: 504 }));
    }, 20000);
    aiPending.set(requestId, { resolve, reject, timeout });
    aiWorker.stdin.write(`${JSON.stringify({ id: requestId, op, imageDataUrl })}\n`, error => {
      if (error) {
        clearTimeout(timeout);
        aiPending.delete(requestId);
        reject(Object.assign(new Error('AI xizmatiga tasvir yuborilmadi.'), { status: 503 }));
      }
    });
  });
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    dot += x * y; normA += x * x; normB += y * y;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : -1;
}

function bestFaceMatch(embedding, rows, threshold = 0.48) {
  const scored = rows.map(row => {
    try { return { row, score: cosineSimilarity(embedding, JSON.parse(reveal(row.faceTemplate))) }; }
    catch { return { row, score: -1 }; }
  }).filter(item => item.score >= threshold).sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: 'none' };
  if (scored[1] && scored[0].score - scored[1].score < 0.08) return { status: 'ambiguous' };
  return { status: 'matched', ...scored[0] };
}

function employeeFaceMatch(embedding) {
  const match = bestFaceMatch(embedding, q.employeeTemplates.all());
  if (match.status !== 'matched') return match;
  return { ...match, employee: { id: match.row.id, employeeCode: match.row.employeeCode, name: reveal(match.row.name) } };
}

function activeVisitFaceMatch(embedding) {
  const match = bestFaceMatch(embedding, q.activeFaceVisits.all());
  if (match.status !== 'matched') return match;
  return { ...match, visit: { id: match.row.id, name: reveal(match.row.name), arrived: match.row.arrived } };
}

function makeFaceTicket(deviceId, mode, imageDataUrl, embedding) {
  const timestamp = Date.now();
  for (const [ticket, value] of faceTickets) if (value.expiresAt <= timestamp) faceTickets.delete(ticket);
  const ticket = crypto.randomBytes(32).toString('base64url');
  faceTickets.set(ticket, { deviceId, mode, imageHash: digest(imageDataUrl), embedding, expiresAt: timestamp + 120000 });
  return ticket;
}

function consumeFaceTicket(ticket, deviceId, imageDataUrl) {
  const data = faceTickets.get(String(ticket || ''));
  faceTickets.delete(String(ticket || ''));
  if (!data || data.expiresAt <= Date.now() || data.mode !== 'entry' || data.deviceId !== deviceId || data.imageHash !== digest(imageDataUrl)) {
    throw Object.assign(new Error('Yuz tekshiruvi eskirgan. Suratni qayta tekshiring.'), { status: 400 });
  }
  return data.embedding;
}

startAiWorker();

const app = async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  try {
    if (req.method === 'GET' && p === '/api/setup-status') return send(res, 200, { setupRequired: q.adminCount.get().n === 0 });
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { status: 'ok', storage: 'local', ai: aiState });

    if (req.method === 'POST' && p === '/api/setup') {
      if (!sameOrigin(req)) return fail(res, 403, 'Manba tekshiruvidan o‘tmadi.');
      if (!isLoopback(req)) return fail(res, 403, 'Birinchi administratorni noutbukning o‘zida yarating.');
      if (q.adminCount.get().n !== 0) return fail(res, 409, 'Administrator oldin yaratilgan.');
      const b = await body(req), username = clean(b.username, 50).toLowerCase(), password = String(b.password || '');
      if (!/^[a-z0-9._-]{3,50}$/.test(username)) return fail(res, 400, 'Login 3–50 ta lotin harf, raqam, nuqta, chiziqcha yoki pastki chiziqdan iborat bo‘lsin.');
      if (password.length < 12 || password.length > 200) return fail(res, 400, 'Parol kamida 12 ta belgidan iborat bo‘lsin.');
      const salt = crypto.randomBytes(16), hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
      const adminId = id('ADM');
      if (q.adminCount.get().n !== 0) return fail(res, 409, 'Administrator allaqachon yaratilgan.');
      q.insertAdmin.run(adminId, username, salt.toString('hex'), hash.toString('hex'), now());
      const raw = crypto.randomBytes(32).toString('base64url');
      q.insertSession.run(digest(raw), adminId, new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString());
      audit(username, 'admin.setup'); setSession(res, req, raw);
      return send(res, 201, { username });
    }

    if (req.method === 'POST' && p === '/api/login') {
      if (!sameOrigin(req)) return fail(res, 403, 'Manba tekshiruvidan o‘tmadi.');
      const ip = req.socket.remoteAddress || 'unknown', attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return fail(res, 429, 'Ko‘p urinish bo‘ldi. 10 daqiqadan keyin urinib ko‘ring.');
      const b = await body(req), username = clean(b.username, 50).toLowerCase(), password = String(b.password || '');
      const a = q.adminByUsername.get(username);
      const actual = a ? Buffer.from(crypto.pbkdf2Sync(password, Buffer.from(a.salt, 'hex'), 210000, 32, 'sha256')) : Buffer.alloc(32);
      const expected = a ? Buffer.from(a.password_hash, 'hex') : Buffer.alloc(32);
      if (!a || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        attempt.count++;
        if (attempt.count >= 5) { attempt.count = 0; attempt.until = Date.now() + 10 * 60 * 1000; }
        loginAttempts.set(ip, attempt); return fail(res, 401, 'Login yoki parol xato.');
      }
      loginAttempts.delete(ip);
      const raw = crypto.randomBytes(32).toString('base64url');
      q.deleteExpired.run(now());
      q.insertSession.run(digest(raw), a.id, new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString());
      audit(username, 'admin.login'); setSession(res, req, raw);
      return send(res, 200, { username });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const s = adminMutation(req, res); if (!s) return;
      const raw = cookies(req).sid; if (raw) q.deleteSession.run(digest(raw));
      audit(s.username, 'admin.logout'); clearSession(res); return send(res, 200, { ok: true });
    }

    if (p.startsWith('/api/admin/')) {
      const s = req.method === 'GET' ? adminOnly(req, res) : adminMutation(req, res);
      if (!s) return;
      if (req.method === 'GET' && p === '/api/admin/dashboard') return send(res, 200, { username: s.username, visits: listVisits(), employees: employeeList(), devices: q.devices.all(), terminalUrls: localUrls(), ai: aiState });
      if (req.method === 'GET' && p === '/api/admin/visits') return send(res, 200, { visits: listVisits() });
      if (req.method === 'POST' && p === '/api/admin/visits') {
        const b = await body(req), name = clean(b.name, 120), purpose = clean(b.purpose, 200) || 'Tashrif';
        if (!name || !purpose) return fail(res, 400, 'F.I.Sh. va tashrif maqsadini kiriting.');
        let photo = null, faceTemplate = null;
        if (b.photoDataUrl) {
          if (aiReady) {
            const analysis = await analyzeFace(b.photoDataUrl);
            if (!analysis.ok) return fail(res, 422, analysis.error);
            faceTemplate = protect(JSON.stringify(analysis.embedding));
          }
          photo = storePhoto(b.photoDataUrl);
        }
        const visitId = id('T');
        q.insertVisit.run(visitId, protect(name), protect(clean(b.organization, 120)), protect(purpose), now(), photo ? 1 : 0, photo, 'Administrator', faceTemplate);
        audit(s.username, 'visit.entry', visitId);
        return send(res, 201, { visit: listVisits().find(v => v.id === visitId) });
      }
      if (req.method === 'GET' && p === '/api/admin/employees') return send(res, 200, { employees: employeeList() });
      if (req.method === 'POST' && p === '/api/admin/employees') {
        const b = await body(req), name = clean(b.name, 120), code = clean(b.id, 40) || id('X'), department = clean(b.department, 120);
        if (!name) return fail(res, 400, 'Xodim F.I.Sh.ini kiriting.');
        const employeeId = id('EMP');
        try { q.insertEmployee.run(employeeId, code, protect(name), protect(department), now()); }
        catch { return fail(res, 409, 'Bu xodim IDsi oldin ishlatilgan.'); }
        audit(s.username, 'employee.create', employeeId);
        return send(res, 201, { employee: employeeList().find(e => e.id === employeeId) });
      }
      const employeeFace = /^\/api\/admin\/employees\/([A-Z0-9-]+)\/face-template$/.exec(p);
      if (req.method === 'POST' && employeeFace) {
        const b = await body(req), employeeId = employeeFace[1];
        if (b.consent !== true) return fail(res, 403, 'Xodim yuz shabloniga aniq rozilik berishi kerak.');
        const storedEmployee = db.prepare('SELECT id, name FROM employees WHERE id=?').get(employeeId);
        if (!storedEmployee) return fail(res, 404, 'Xodim topilmadi.');
        const analysis = await analyzeFace(b.imageDataUrl);
        if (!analysis.ok) return fail(res, 422, analysis.error);
        q.setEmployeeTemplate.run(protect(JSON.stringify(analysis.embedding)), employeeId);
        audit(s.username, 'employee.face-template.set', employeeId);
        return send(res, 200, { ok: true, employee: { id: employeeId, name: reveal(storedEmployee.name), hasFaceTemplate: true } });
      }
      if (req.method === 'DELETE' && employeeFace) {
        const result = q.deleteEmployeeTemplate.run(employeeFace[1]);
        if (!result.changes) return fail(res, 404, 'Xodim topilmadi.');
        audit(s.username, 'employee.face-template.delete', employeeFace[1]);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/admin/devices') return send(res, 200, { devices: q.devices.all() });
      if (req.method === 'POST' && p === '/api/admin/devices') {
        const b = await body(req), name = clean(b.name, 80), direction = clean(b.direction, 12);
        if (!name) return fail(res, 400, 'Terminal nomini kiriting.');
        if (!['entry', 'exit'].includes(direction)) return fail(res, 400, 'Terminal vazifasini tanlang.');
        const deviceId = id('DEV'), raw = oneTimeToken();
        q.insertDevice.run(deviceId, name, digest(raw), now(), direction); audit(s.username, `device.create.${direction}`, deviceId);
        return send(res, 201, { device: q.devices.all().find(d => d.id === deviceId), token: raw, terminalUrl: '/terminal' });
      }
      const revoke = /^\/api\/admin\/devices\/([A-Z0-9-]+)$/.exec(p);
      if (req.method === 'DELETE' && revoke) {
        const result = q.revokeDevice.run(now(), revoke[1]);
        if (!result.changes) return fail(res, 404, 'Faol terminal topilmadi.');
        audit(s.username, 'device.revoke', revoke[1]); return send(res, 200, { ok: true });
      }
      const photo = /^\/api\/admin\/visits\/([A-Z0-9-]+)\/photo$/.exec(p);
      if (req.method === 'GET' && photo) {
        const row = q.photo.get(photo[1]);
        if (!row?.photo_file) return fail(res, 404, 'Saqlangan surat topilmadi.');
        return send(res, 200, readPhoto(row.photo_file), 'image/jpeg');
      }
      const exit = /^\/api\/admin\/visits\/([A-Z0-9-]+)\/checkout$/.exec(p);
      if (req.method === 'POST' && exit) {
        const result = q.checkout.run(now(), exit[1]);
        if (!result.changes) return fail(res, 409, 'Tashrif topilmadi yoki oldin yopilgan.');
        audit(s.username, 'visit.checkout', exit[1]); return send(res, 200, { ok: true, departed: now() });
      }
      return fail(res, 404, 'API manzili topilmadi.');
    }

    if (p.startsWith('/api/device/')) {
      const d = deviceOnly(req, res); if (!d) return;
      if (req.method === 'GET' && p === '/api/device/me') return send(res, 200, { device: { id: d.id, name: d.name, direction: d.direction }, ai: aiState, employeeTemplateCount: q.employeeTemplates.all().length, employeeCount: q.employees.all().length, activeVisits: d.direction === 'entry' ? [] : activeVisits() });
      if (req.method === 'GET' && p === '/api/device/active-visits') {
        if (d.direction === 'entry') return fail(res, 403, 'Bu terminal faqat kirish uchun sozlangan.');
        return send(res, 200, { visits: activeVisits() });
      }
      if (req.method === 'POST' && p === '/api/device/face-detect') {
        const b = await body(req);
        const detection = await analyzeFace(b.imageDataUrl, 'detect');
        if (!detection.ok) return fail(res, 422, detection.error);
        return send(res, 200, { faces: detection.faces });
      }
      if (req.method === 'POST' && p === '/api/device/face-match') {
        const b = await body(req), mode = clean(b.mode, 20);
        if (!['employee-check', 'entry', 'exit'].includes(mode)) return fail(res, 400, 'Yuz tekshiruvi rejimini tanlang.');
        if (mode === 'entry' && d.direction === 'exit') return fail(res, 403, 'Bu terminal faqat chiqish uchun sozlangan.');
        if (mode === 'exit' && d.direction === 'entry') return fail(res, 403, 'Bu terminal faqat kirish uchun sozlangan.');
        if (mode === 'entry') {
          const employeeCount = q.employees.all().length, templateCount = q.employeeTemplates.all().length;
          // Only a registered employee without a face template could be mistaken for a visitor.
          if (templateCount !== employeeCount) return send(res, 200, { type: 'employee_setup_incomplete', error: 'Tashrifchi suratga olinmasidan oldin administrator barcha xodimlarning yuz shablonini kiritishi kerak.' });
        }
        const analysis = await analyzeFace(b.imageDataUrl);
        if (!analysis.ok) return fail(res, 422, analysis.error);
        const embedding = analysis.embedding;
        const staffMatch = employeeFaceMatch(embedding);
        if (staffMatch.status === 'ambiguous') return send(res, 200, { type: 'ambiguous', error: 'Xodim shablonlari bir-biriga yaqin chiqdi. Operator yordamida davom eting.' });
        if (staffMatch.status === 'matched') {
          audit(`device:${d.id}`, 'face.employee.match', staffMatch.employee.id);
          return send(res, 200, { type: 'employee', employee: staffMatch.employee, similarity: Number(staffMatch.score.toFixed(3)) });
        }
        if (mode === 'employee-check') {
          audit(`device:${d.id}`, 'face.employee.no-match', null);
          return send(res, 200, { type: 'not_employee', error: 'Xodim shabloni topilmadi.' });
        }
        if (mode === 'entry') {
          const current = activeVisitFaceMatch(embedding);
          if (current.status === 'ambiguous') return send(res, 200, { type: 'ambiguous', error: 'Faol tashrif shablonlari aniq ajralmadi. Operator yordamida davom eting.' });
          if (current.status === 'matched') return send(res, 200, { type: 'already_inside', visit: current.visit, similarity: Number(current.score.toFixed(3)) });
          const ticket = makeFaceTicket(d.id, 'entry', b.imageDataUrl, embedding);
          audit(`device:${d.id}`, 'face.visitor.new', null);
          return send(res, 200, { type: 'new_visitor', ticket, confidence: analysis.faceConfidence });
        }
        const current = activeVisitFaceMatch(embedding);
        if (current.status === 'ambiguous') return send(res, 200, { type: 'ambiguous', error: 'Bir nechta tashrifchi mos keldi. Ro‘yxatdan qo‘lda tanlang.' });
        if (current.status === 'matched') {
          const departed = now();
          const result = q.checkout.run(departed, current.visit.id);
          if (!result.changes) return send(res, 409, { error: 'Tashrif allaqachon yopilgan.' });
          audit(`device:${d.id}`, 'visit.face-checkout', current.visit.id);
          return send(res, 200, { type: 'checked_out', visit: current.visit, departed, similarity: Number(current.score.toFixed(3)) });
        }
        audit(`device:${d.id}`, 'face.exit.unmatched', null);
        return send(res, 200, { type: 'not_matched', error: 'Faol tashrifchi yuz shabloni topilmadi. Chiqishni ro‘yxatdan qo‘lda qayd eting.' });
      }
      if (req.method === 'POST' && p === '/api/device/entry') {
        if (d.direction === 'exit') return fail(res, 403, 'Bu terminal faqat chiqish uchun sozlangan.');
        const b = await body(req), purpose = clean(b.purpose, 200) || 'Tashrif';
        // The kiosk terminal no longer asks for a name; the photo and arrival time identify the visitor.
        const name = clean(b.name, 120) || `Tashrifchi (${new Intl.DateTimeFormat('uz-UZ', { hour: '2-digit', minute: '2-digit' }).format(new Date())})`;
        if (!b.photoDataUrl) return fail(res, 400, 'Tashrifchi suratini oling.');
        if (aiReady && !b.faceTicket) return fail(res, 400, 'Kirishdan oldin yuzni YOLO orqali tekshiring.');
        const embedding = b.faceTicket ? consumeFaceTicket(b.faceTicket, d.id, b.photoDataUrl) : null;
        const photo = storePhoto(b.photoDataUrl), visitId = id('T');
        q.insertVisit.run(visitId, protect(name), protect(clean(b.organization, 120)), protect(purpose), now(), 1, photo, `Terminal: ${d.name}`, embedding ? protect(JSON.stringify(embedding)) : null);
        audit(`device:${d.id}`, 'visit.entry', visitId);
        return send(res, 201, { visit: listVisits().find(v => v.id === visitId) });
      }
      const exit = /^\/api\/device\/visits\/([A-Z0-9-]+)\/checkout$/.exec(p);
      if (req.method === 'POST' && exit) {
        if (d.direction === 'entry') return fail(res, 403, 'Bu terminal faqat kirish uchun sozlangan.');
        const result = q.checkout.run(now(), exit[1]);
        if (!result.changes) return fail(res, 409, 'Tashrif topilmadi yoki oldin yopilgan.');
        audit(`device:${d.id}`, 'visit.checkout', exit[1]); return send(res, 200, { ok: true, departed: now() });
      }
      return fail(res, 404, 'Terminal API manzili topilmadi.');
    }

    if (req.method === 'GET' && p === '/certificate') {
      if (!fs.existsSync(caPath)) return fail(res, 404, 'Lokal sertifikat topilmadi.');
      res.setHeader('Content-Disposition', 'attachment; filename="tashrif-local-ca.cer"');
      return send(res, 200, fs.readFileSync(caPath), 'application/x-x509-ca-cert');
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/terminal') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'terminal.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    return fail(res, 404, 'Sahifa topilmadi.');
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    console.error(`${new Date().toISOString()} ${req.method} ${p}: ${e.message}`);
    return fail(res, 500, 'Server xatosi. Administrator terminal jurnalini tekshirsin.');
  }
};

const server = http.createServer((req, res) => {
  if (!tlsConfig) return app(req, res);
  let requestUrl;
  try { requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.statusCode = 400; return res.end('Noto‘g‘ri so‘rov.'); }
  if (req.method === 'GET' && requestUrl.pathname === '/certificate') return app(req, res);
  if (req.method !== 'GET') {
    res.statusCode = 426;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: 'Xavfsiz ulanish uchun HTTPS manzilidan foydalaning.' }));
  }
  let hostname;
  try { hostname = new URL(`http://${req.headers.host || ''}`).hostname; }
  catch { res.statusCode = 400; return res.end('Noto‘g‘ri host.'); }
  const knownHosts = new Set(['localhost', '127.0.0.1']);
  for (const entries of Object.values(os.networkInterfaces())) for (const n of entries || []) {
    if (n.family === 'IPv4' && !n.internal) knownHosts.add(n.address);
  }
  if (!knownHosts.has(hostname)) { res.statusCode = 421; return res.end('Noma’lum lokal manzil.'); }
  const location = `https://${hostname}:${TLS_PORT}${req.url || '/'}`;
  res.statusCode = 308;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
});

const tlsServer = tlsConfig ? https.createServer(tlsConfig, app) : null;
server.listen(PORT, HOST, () => {
  console.log(`HTTP yo‘naltiruvchi ishga tushdi: http://localhost:${PORT}`);
  if (!tlsConfig) console.log('HTTPS sertifikati topilmadi. start-server.ps1 orqali ishga tushiring.');
  for (const nets of Object.values(os.networkInterfaces())) for (const n of nets || []) {
    if (n.family === 'IPv4' && !n.internal) {
      if (tlsConfig) {
        console.log(`Planshet/lokal tarmoq: https://${n.address}:${TLS_PORT}/terminal`);
        console.log(`Sertifikatni yuklab olish: http://${n.address}:${PORT}/certificate`);
      } else console.log(`Planshet/lokal tarmoq: http://${n.address}:${PORT}/terminal`);
    }
  }
  console.log(`Ma’lumotlar: ${DATA}`);
});
if (tlsServer) tlsServer.listen(TLS_PORT, HOST, () => console.log(`HTTPS serveri ishga tushdi: https://localhost:${TLS_PORT}`));
function shutdown() {
  db.close();
  if (aiWorker) aiWorker.kill();
  if (tlsServer) tlsServer.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
