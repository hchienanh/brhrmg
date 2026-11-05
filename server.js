// BR Chấm công — Server LAN v6.4 (HRM dùng chung trên VPS, xác thực, kiểm tra đầu vào)
const SERVER_VERSION = '6.4';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');

const CFG_FILE = path.join(__dirname, 'config.json');
const DB_FILE = path.join(__dirname, 'data.json');
const HRM_DB_FILE = path.join(__dirname, 'hrm.json');
const PHOTOS_DIR = path.join(__dirname, 'photos');
const MODELS_DIR = path.join(__dirname, 'models');
const INDEX_HTML_FILE = path.join(__dirname, 'index.html');
const MOBILE_HTML_FILE = path.join(__dirname, 'mobile.html');
const HRM_HTML_FILE = path.join(__dirname, 'BRhrmG.html');

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });

// [FIX A1] Chỉ trả fallback khi file KHÔNG tồn tại. File hỏng => giữ bản sao và dừng, tuyệt đối không ghi đè.
// Bỏ BOM (Notepad/Windows hay thêm); file rỗng => undefined
const parseText = raw => { const t = String(raw).replace(/^\uFEFF/, ''); return t.trim() === '' ? undefined : JSON.parse(t); };
const readJson = (file, fallback) => {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  let val, err = null;
  try { val = parseText(raw); } catch (e) { err = e; }
  if (!err && val !== undefined) return val;
  // File rỗng hoặc hỏng: giữ bản sao, thử khôi phục từ .bak, không ghi đè bừa
  if (err) {
    const stamp = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, stamp); } catch (_) { /* bỏ qua */ }
    console.error(`⚠️ File ${path.basename(file)} bị hỏng (${err.message}). Đã giữ bản sao: ${path.basename(stamp)}`);
  }
  try {
    const b = parseText(fs.readFileSync(file + '.bak', 'utf8'));
    if (b !== undefined) { console.warn(`⚠️ Đã tự khôi phục ${path.basename(file)} từ ${path.basename(file)}.bak (có thể mất vài phút dữ liệu gần nhất).`); return b; }
  } catch (_) { /* không có .bak hợp lệ */ }
  if (!err) return fallback; // file rỗng và không có bản sao lưu: không có gì để mất
  console.error(`❌ Không có bản sao lưu hợp lệ. Server dừng để KHÔNG ghi đè dữ liệu. Hãy sửa tay ${path.basename(file)} rồi chạy lại.`);
  process.exit(1);
};

// [FIX A1] Ghi atomic: ghi file tạm rồi rename, mất điện giữa chừng không làm cụt file thật.
const writeAtomic = (file, text) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};
const envAdminToken = String(process.env.BRHRMG_ADMIN_TOKEN || '').trim();
const envManagerToken = String(process.env.BRHRMG_MANAGER_TOKEN || '').trim();
if ((envAdminToken && envAdminToken.length < 32) || (envManagerToken && envManagerToken.length < 32)) {
  console.error('❌ Token môi trường phải dài ít nhất 32 ký tự.');
  process.exit(1);
}
const configForDisk = config => {
  const persistedCfg = { ...config };
  if (envAdminToken) delete persistedCfg.adminToken;
  if (envManagerToken) delete persistedCfg.managerToken;
  return persistedCfg;
};

const defaultBranches = () => [
  { id: "CN_Q1", name: "Chi nhánh Quận 1 (Trụ sở chính)", address: "127 Nguyễn Huệ, Q.1, TP.HCM" },
  { id: "CN_Q3", name: "Chi nhánh Quận 3", address: "45 Võ Văn Tần, Q.3, TP.HCM" }
];
const defaultCfg = () => ({
  port: 3000,
  listenHost: '0.0.0.0',
  adminToken: crypto.randomBytes(12).toString('hex'),
  managerToken: 'mgr_' + crypto.randomBytes(8).toString('hex'),
  maxPhotoKB: 800,
  retentionDays: 365,
  allowedPrefixes: ['192.168.', '10.', '172.16.', '127.0.0.1', '::1'],
  faceThreshold: 0.48,
  requireDeviceForSelfApi: true, // đặt false nếu mobile.html chưa gửi deviceId cho /api/my-schedule và /api/schedule-preference
  tlsCertFile: '',
  tlsKeyFile: '',
  requireHttps: false,
  publicOrigin: '',
  trustedProxyAddresses: [],
  allowedOrigins: [],
  shifts: [
    { id: "CA_SANG", name: "Ca Sáng", startTime: "08:00", endTime: "14:00", standardHours: 6 },
    { id: "CA_TOI", name: "Ca Tối", startTime: "14:00", endTime: "22:00", standardHours: 8 },
    { id: "CA_GAY", name: "Ca Gãy", startTime: "09:30", endTime: "21:30", breakStart: "14:00", breakEnd: "16:30", standardHours: 9.5 }
  ],
  branches: defaultBranches()
});

// [FIX A2] Gộp config cũ với mặc định (giữ nguyên mọi giá trị đã có), chỉ bổ sung khóa còn thiếu.
let cfg = readJson(CFG_FILE, null);
{
  const def = defaultCfg();
  let changed = false;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { cfg = {}; changed = true; }
  for (const k of Object.keys(def)) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') { cfg[k] = def[k]; changed = true; }
  }
  if (!Number.isInteger(Number(cfg.port)) || Number(cfg.port) < 1 || Number(cfg.port) > 65535) {
    console.error('❌ port phải là số nguyên từ 1 đến 65535.');
    process.exit(1);
  }
  cfg.port = Number(cfg.port);
  if (typeof cfg.listenHost !== 'string' || net.isIP(cfg.listenHost) === 0) {
    console.error('❌ listenHost phải là một địa chỉ IPv4 hoặc IPv6 hợp lệ.');
    process.exit(1);
  }
  if (!Array.isArray(cfg.allowedPrefixes)) { cfg.allowedPrefixes = def.allowedPrefixes; changed = true; }
  if (!Array.isArray(cfg.trustedProxyAddresses) || cfg.trustedProxyAddresses.some(ip => typeof ip !== 'string' || net.isIP(ip) === 0)) {
    cfg.trustedProxyAddresses = def.trustedProxyAddresses;
    changed = true;
  } else {
    const trustedProxyAddresses = [...new Set(cfg.trustedProxyAddresses)];
    if (JSON.stringify(trustedProxyAddresses) !== JSON.stringify(cfg.trustedProxyAddresses)) {
      cfg.trustedProxyAddresses = trustedProxyAddresses;
      changed = true;
    }
  }
  if (typeof cfg.publicOrigin !== 'string') { cfg.publicOrigin = def.publicOrigin; changed = true; }
  if (!Array.isArray(cfg.allowedOrigins)) { cfg.allowedOrigins = def.allowedOrigins; changed = true; }
  else {
    const allowedOrigins = [...new Set(cfg.allowedOrigins.filter(origin => {
      if (typeof origin !== 'string') return false;
      try { const parsed = new URL(origin); return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin; }
      catch (_) { return false; }
    }))];
    if (JSON.stringify(allowedOrigins) !== JSON.stringify(cfg.allowedOrigins)) { cfg.allowedOrigins = allowedOrigins; changed = true; }
  }
  if (!Array.isArray(cfg.branches) || !cfg.branches.length || cfg.branches.some(branch => !branch || !branch.id || !branch.name)) {
    cfg.branches = def.branches;
    changed = true;
  }
  if (changed) writeAtomic(CFG_FILE, JSON.stringify(configForDisk(cfg), null, 2));
}
if (cfg.publicOrigin) {
  try {
    const publicUrl = new URL(cfg.publicOrigin);
    if (publicUrl.protocol !== 'https:' || publicUrl.origin !== cfg.publicOrigin || publicUrl.pathname !== '/') throw new Error();
  } catch (_) {
    console.error('❌ publicOrigin phải là HTTPS origin hợp lệ, ví dụ https://hrm.example.com.');
    process.exit(1);
  }
}
if (Boolean(cfg.publicOrigin) !== Boolean(cfg.trustedProxyAddresses.length)) {
  console.error('❌ Cần cấu hình đồng thời publicOrigin và trustedProxyAddresses, hoặc để trống cả hai.');
  process.exit(1);
}
const saveConfig = () => writeAtomic(CFG_FILE, JSON.stringify(configForDisk(cfg), null, 2));
if (envAdminToken) cfg.adminToken = envAdminToken;
if (envManagerToken) cfg.managerToken = envManagerToken;
if (envAdminToken || envManagerToken) saveConfig();

let data = readJson(DB_FILE, { employees: [], inbox: [] });
let sharedHrm = readJson(HRM_DB_FILE, null);
const MAX_HRM_DB_BYTES = 32 * 1024 * 1024;
const isValidHrmDatabase = value => Boolean(
  value && typeof value === 'object' && !Array.isArray(value) &&
  Array.isArray(value.employees) && Array.isArray(value.attendance) &&
  Array.isArray(value.shifts) && value.rules && typeof value.rules === 'object' &&
  Array.isArray(value.branches)
);
if (sharedHrm !== null && (
  !sharedHrm || typeof sharedHrm !== 'object' || !Number.isSafeInteger(sharedHrm.revision) ||
  !isValidHrmDatabase(sharedHrm.db)
)) {
  console.error(`❌ File ${path.basename(HRM_DB_FILE)} có cấu trúc không hợp lệ. Server dừng để tránh ghi đè dữ liệu HRM.`);
  process.exit(1);
}

const pinFails = {};
const enrolls = {};
const hits = {};
const toMin = x => { const [h, m] = String(x || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const pad2 = n => String(n).padStart(2, '0');
const BUSINESS_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const businessDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const businessDateParts = ts => {
  const parts = Object.fromEntries(businessDateTimeFormatter.formatToParts(new Date(ts)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
};
const dayOf = ts => {
  const { year, month, day } = businessDateParts(ts);
  return `${year}-${pad2(month)}-${pad2(day)}`;
};
const monthOf = ts => dayOf(ts).slice(0, 7);
const timeOf = ts => {
  const { hour, minute } = businessDateParts(ts);
  return `${pad2(hour)}:${pad2(minute)}`;
};
const weekdayOf = ts => new Date(`${dayOf(ts)}T00:00:00Z`).getUTCDay();
const addCalendarDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const calendarDayDifference = (from, to) => (Date.parse(`${from}T00:00:00Z`) - Date.parse(`${to}T00:00:00Z`)) / 864e5;
const isValidCalendarDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
  new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
// Tương thích Node cũ: thay cho toán tử ?? và crypto.randomUUID()
const pick = (...v) => { for (const x of v) if (x !== undefined && x !== null) return x; return undefined; };
const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const isDesc128 = d => Array.isArray(d) && d.length === 128 && d.every(x => typeof x === 'number' && Number.isFinite(x));

// [FIX A4] Giới hạn thử sai PIN / xác thực khuôn mặt: 5 lần / 15 phút theo (nhân viên + IP), 50 lần / 15 phút theo nhân viên.
const FAIL_WINDOW = 15 * 60e3;
const failCount = k => { const a = (pinFails[k] || []).filter(t => Date.now() - t < FAIL_WINDOW); pinFails[k] = a; return a.length; };
const addFail = k => { (pinFails[k] = pinFails[k] || []).push(Date.now()); };
const isLocked = (empId, ip) => failCount('i|' + empId + '|' + ip) >= 5 || failCount('e|' + empId) >= 50;
const noteFail = (empId, ip) => { addFail('i|' + empId + '|' + ip); addFail('e|' + empId); };
const clearFail = (empId, ip) => { delete pinFails['i|' + empId + '|' + ip]; };
// Giới hạn tần suất chung: trả true nếu đã vượt.
const rateHit = (key, max, windowMs) => {
  const now = Date.now(), a = (hits[key] || []).filter(t => now - t < windowMs);
  if (a.length >= max) { hits[key] = a; return true; }
  a.push(now); hits[key] = a; return false;
};

function authDevice(emp, b) {
  const dev = String(b.deviceId || '').slice(0, 64);
  if (!dev) return { code: 400, error: 'Thiếu mã thiết bị, hãy tải lại trang.' };
  if (!emp.deviceId) return { code: 403, error: 'Điện thoại chưa được đăng ký. Hãy chấm công bằng khuôn mặt trước.' };
  if (emp.deviceId !== dev) return { code: 403, error: 'Điện thoại này chưa được đăng ký cho bạn. Nhờ quản lý gỡ thiết bị cũ rồi thử lại.' };
  return null;
}
// [FIX A7] Quyền xem/sửa dữ liệu cá nhân: quản lý/admin (có token) hoặc đúng điện thoại đã đăng ký của nhân viên.
const selfAuthError = (role, emp, deviceId) => {
  if (role !== 'GUEST' || cfg.requireDeviceForSelfApi === false) return null;
  return authDevice(emp, { deviceId });
};

// Kiểm tra quy tắc ca ngay tại server để báo kết quả cho nhân viên tức thì
function validateScan(emp, action, branchId) {
  const nowTs = Date.now(), today = dayOf(nowTs);
  const mine = (data.inbox || []).filter(r => r.empId === emp.id && r.status === 'DONE' && !r.appRejected);
  const last = mine[mine.length - 1], open = last && last.action === 'in' && nowTs - last.ts < 20 * 3600e3;
  if (open && last.branchId && last.branchId !== branchId) {
    const branch = (cfg.branches || []).find(item => item.id === last.branchId);
    return `Bạn đang có phiên chấm công tại ${branch ? branch.name : 'chi nhánh khác'}, hãy kết thúc phiên đó trước.`;
  }
  if (action === 'out') return open ? null : 'Bạn chưa vào ca, không thể ra ca.';
  if (open) return `Bạn đã vào ca lúc ${last.timeStr}, hãy chấm RA CA.`;
  if (emp.schedDate !== today || !Array.isArray(emp.todayShifts)) return null; // chưa có lịch đồng bộ: app sẽ kiểm tra sau
  if (!emp.todayShifts.length) return 'Hôm nay bạn không có ca làm.';
  if (mine.filter(r => r.action === 'in' && dayOf(r.ts) === today).length >= emp.todayShifts.length) return 'Bạn đã chấm đủ số ca hôm nay.';
  const { hour, minute } = businessDateParts(nowTs), nm = hour * 60 + minute;
  const ok = emp.todayShifts.some(s => { const a = toMin(s.start), z = toMin(s.end); return z > a ? (nm >= a - 120 && nm <= z) : nm >= a - 120; });
  return ok ? null : 'Ngoài khung giờ vào ca (sớm tối đa 2 giờ, đến hết ca).';
}

let lastBackupTs = 0;
const saveDb = () => {
  const retentionMs = (cfg.retentionDays || 365) * 864e5;
  const now = Date.now();
  for (const k of Object.keys(data.photoHashes || {})) if (now - data.photoHashes[k] > 864e5) delete data.photoHashes[k];
  data.requests = (data.requests || []).filter(x => now - x.ts < retentionMs);
  data.inbox = (data.inbox || []).filter(item => (now - item.ts) < retentionMs);
  // [FIX A1] Giữ bản sao .bak (tối đa 10 phút/lần) rồi ghi atomic
  if (now - lastBackupTs > 10 * 60e3 && fs.existsSync(DB_FILE)) {
    try {
      if (parseText(fs.readFileSync(DB_FILE, 'utf8')) !== undefined) { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); lastBackupTs = now; }
    } catch (e) { /* file hiện tại hỏng: không để nó đè lên bản sao lưu tốt */ }
  }
  writeAtomic(DB_FILE, JSON.stringify(data, null, 2));
};

{
  let dirty = false;
  if (!data.branches) { data.branches = cfg.branches || []; dirty = true; }
  // [FIX A3] Không để tồn tại PIN rỗng (trước đây cho đổi PIN không cần mật khẩu cũ). Mặc định '0000' như màn quản lý vẫn hiển thị.
  const branchIds = new Set((cfg.branches || []).map(branch => String(branch.id)));
  (data.employees || []).forEach(e => {
    if (!e.pin) { e.pin = '0000'; dirty = true; }
    if (!Array.isArray(e.branchIds)) { e.branchIds = cfg.branches.length ? [cfg.branches[0].id] : []; dirty = true; }
    const validBranchIds = [...new Set(e.branchIds.map(String).filter(id => branchIds.has(id)))];
    if (!validBranchIds.length && cfg.branches.length) validBranchIds.push(cfg.branches[0].id);
    if (JSON.stringify(validBranchIds) !== JSON.stringify(e.branchIds)) { e.branchIds = validBranchIds; dirty = true; }
  });
  if (JSON.stringify(data.branches) !== JSON.stringify(cfg.branches)) { data.branches = cfg.branches; dirty = true; }
  if (dirty) saveDb();
}

const MAX_BODY_BYTES = () => (cfg.maxPhotoKB || 800) * 1400;
const BIG_BODY = 8 * 1024 * 1024; // đồng bộ nhân viên (avatar base64) / lịch: chỉ dùng cho API admin đã xác thực
const ipOf = req => (req.socket.remoteAddress || '').replace('::ffff:', '');
const isTrustedProxy = ip => cfg.trustedProxyAddresses.includes(ip);
const clientIpOf = (req, peerIp) => {
  if (!isTrustedProxy(peerIp)) return peerIp;
  const forwardedIp = req.headers['x-real-ip'];
  const clientIp = typeof forwardedIp === 'string' ? forwardedIp.trim().replace('::ffff:', '') : '';
  return net.isIP(clientIp) ? clientIp : peerIp;
};
// [FIX B] Dải private 172.16.0.0/12 gồm 172.16–172.31 (trước đây chỉ khớp 172.16.x.x)
const isIpAllowed = ip => {
  if (isTrustedProxy(ip)) return true;
  const list = Array.isArray(cfg.allowedPrefixes) ? cfg.allowedPrefixes : [];
  if (list.some(p => ip === p || ip.startsWith(p))) return true;
  return list.includes('172.16.') && /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
};

const send = (res, code, obj, type = 'application/json') => {
  res.writeHead(code, {
    'Content-Type': type + '; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
};

// [FIX A8] setEncoding('utf8') => không làm hỏng ký tự tiếng Việt nằm ở ranh giới chunk; quá lớn => 413, JSON sai => 400.
const parseBody = (req, maxBytes = MAX_BODY_BYTES() + 10000) => new Promise((resolve, reject) => {
  let bodyStr = '', size = 0, aborted = false;
  req.setEncoding('utf8');
  req.on('data', c => {
    if (aborted) return;
    size += Buffer.byteLength(c);
    if (size > maxBytes) {
      aborted = true; bodyStr = '';
      const e = new Error('Payload quá lớn'); e.code = 'TOO_BIG';
      return reject(e);
    }
    bodyStr += c;
  });
  req.on('end', () => { if (aborted) return; try { resolve(JSON.parse(bodyStr || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

function calcEuclideanDistance(v1, v2) {
  if (!v1 || !v2 || v1.length !== v2.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < v1.length; i++) {
    const d = v1[i] - v2[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// [FIX A6] Dọn ảnh quá hạn lưu trữ (trước đây ảnh không bao giờ bị xóa). Giữ ảnh đang được dùng làm ảnh đăng ký.
function cleanOldPhotos() {
  try {
    const keepMs = (cfg.retentionDays || 365) * 864e5, now = Date.now(), ref = new Set();
    (data.employees || []).forEach(e => {
      if (e.photoRef) ref.add(path.basename(e.photoRef));
      if (e.pendingFace && e.pendingFace.photoRef) ref.add(path.basename(e.pendingFace.photoRef));
    });
    let n = 0;
    for (const f of fs.readdirSync(PHOTOS_DIR)) {
      if (ref.has(f)) continue;
      const fp = path.join(PHOTOS_DIR, f);
      const st = fs.statSync(fp);
      if (st.isFile() && now - st.mtimeMs > keepMs) { fs.unlinkSync(fp); n++; }
    }
    if (n) console.log(`🧹 Đã xóa ${n} ảnh quá hạn lưu trữ.`);
  } catch (e) { console.error('Dọn ảnh lỗi:', e.message); }
}

const handleRequest = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const peerIp = ipOf(req);
    const trustedProxy = isTrustedProxy(peerIp);
    const ip = clientIpOf(req, peerIp);
    const origin = req.headers.origin;
    const requestOrigin = trustedProxy && cfg.publicOrigin
      ? cfg.publicOrigin
      : `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || `localhost:${cfg.port}`}`;
    const originAllowed = Boolean(origin && origin !== 'null' && (origin === requestOrigin || cfg.allowedOrigins.includes(origin)));
    if (origin && !originAllowed) return send(res, 403, { ok: false, error: 'Nguồn truy cập không được phép.' });
    if (originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.socket.encrypted || (trustedProxy && cfg.publicOrigin)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    if (req.method === 'OPTIONS') return originAllowed
      ? send(res, 204, '')
      : send(res, 403, { ok: false, error: 'Preflight yêu cầu Origin được phép.' });
    if (!isIpAllowed(peerIp)) return send(res, 403, { ok: false, error: 'Chỉ kết nối trong mạng WiFi cửa hàng.' });

    const getRole = () => {
      const token = String(req.headers['x-admin-token'] || '');
      if (token && safeEq(token, cfg.adminToken)) return 'ADMIN';
      if (token && safeEq(token, cfg.managerToken)) return 'MANAGER';
      return 'GUEST';
    };

    if (url.pathname === '/') {
      if (!fs.existsSync(INDEX_HTML_FILE)) return send(res, 404, 'Không tìm thấy file index.html', 'text/plain');
      return send(res, 200, fs.readFileSync(INDEX_HTML_FILE, 'utf8'), 'text/html');
    }
    if (url.pathname === '/quanli' || url.pathname === '/quanli/' || url.pathname === '/hrm' || url.pathname === '/hrm/') {
      if (!fs.existsSync(HRM_HTML_FILE)) return send(res, 404, 'Không tìm thấy file BRhrmG.html', 'text/plain');
      return send(res, 200, fs.readFileSync(HRM_HTML_FILE, 'utf8'), 'text/html');
    }
    if (url.pathname === '/chamcong' || url.pathname === '/chamcong/') {
      if (!fs.existsSync(MOBILE_HTML_FILE)) return send(res, 404, 'Không tìm thấy file mobile.html', 'text/plain');
      return send(res, 200, fs.readFileSync(MOBILE_HTML_FILE, 'utf8'), 'text/html');
    }

    if (url.pathname === '/api/version') return send(res, 200, { ok: true, version: SERVER_VERSION });

    if (url.pathname.startsWith('/photos/')) {
      const tk = url.searchParams.get('t') || '';
      if (!tk || !(safeEq(tk, cfg.adminToken) || safeEq(tk, cfg.managerToken))) return send(res, 401, { ok: false, error: 'Ảnh được bảo vệ.' });
      const p = path.join(PHOTOS_DIR, path.basename(url.pathname));
      if (!isFile(p)) return send(res, 404, { ok: false });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      const st = fs.createReadStream(p);
      st.on('error', () => res.destroy());
      return st.pipe(res);
    }

    if (url.pathname.startsWith('/models/')) {
      const p = path.join(MODELS_DIR, path.basename(url.pathname));
      if (!isFile(p)) return send(res, 404, { ok: false, error: 'Thiếu file model AI' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' });
      const st = fs.createReadStream(p);
      st.on('error', () => res.destroy());
      return st.pipe(res);
    }

    if (url.pathname === '/api/bootstrap') {
      const empId = url.searchParams.get('empId');

      let empStats = { shiftsCount: 0, lateCount: 0, overtimeCount: 0, penaltyCount: 0, advanceCount: 0, todayHours: 0, lastCheckIn: '', lastCheckOut: '', attendanceStatus: null, todayShifts: [] };
      const requestedEmp = empId ? (data.employees || []).find(e => e.id === empId) : null;
      const canViewEmpDetails = Boolean(requestedEmp && !selfAuthError(getRole(), requestedEmp, url.searchParams.get('deviceId')));

      if (canViewEmpDetails) {
        const emp = requestedEmp;
        const todayStr = dayOf(Date.now());
        const empRecs = (data.inbox || []).filter(r => r.empId === empId && r.status === 'DONE');
        const todayRecs = empRecs.filter(r => dayOf(r.ts) === todayStr);

        empStats.shiftsCount = empRecs.filter(r => r.action === 'in').length;
        empStats.lateCount = emp.lateCount || 0;
        empStats.overtimeCount = emp.overtimeCount || 0;
        empStats.penaltyCount = emp.penaltyCount || 0;
        empStats.advanceCount = emp.advanceCount || 0;
        empStats.todayShifts = emp.todayShifts || [];

        const inToday = todayRecs.find(r => r.action === 'in');
        const outToday = todayRecs.find(r => r.action === 'out');
        if (inToday) empStats.lastCheckIn = inToday.timeStr || timeOf(inToday.ts);
        if (outToday) empStats.lastCheckOut = outToday.timeStr || timeOf(outToday.ts);

        if (inToday && outToday && outToday.ts > inToday.ts) {
          empStats.todayHours = Math.round(((outToday.ts - inToday.ts) / 3600000) * 10) / 10;
        }

        // Đánh giá trạng thái chấm công chi tiết cho ca hôm nay
        const isOffToday = (data.schedulePreferences || []).some(p => p.empId === empId && p.date === todayStr && p.status === 'OFF');
        const pendingReq = (data.requests || []).find(r => r.empId === empId && r.status === 'PENDING' && (r.date === todayStr || !inToday));
        const lastRec = empRecs[empRecs.length - 1];
        const isForgotOut = lastRec && lastRec.action === 'in' && dayOf(lastRec.ts) !== todayStr && (Date.now() - lastRec.ts > 12 * 3600e3);
        if (lastRec && lastRec.action === 'in' && Date.now() - lastRec.ts < 20 * 3600e3) empStats.activeBranchId = lastRec.branchId || '';

        const currentShift = (emp.todayShifts && emp.todayShifts[0]) || null;
        let statusCode = 'READY', statusLabel = 'Chưa vào ca', statusColor = '#94a3b8';

        if (isOffToday) {
          statusCode = 'OFF';
          statusLabel = 'Đã xin nghỉ off';
          statusColor = '#a855f7';
        } else if (pendingReq) {
          statusCode = 'PENDING';
          statusLabel = 'Chờ duyệt';
          statusColor = '#0284c7';
        } else if (isForgotOut) {
          statusCode = 'FORGOT';
          statusLabel = 'Quên chấm công';
          statusColor = '#f59e0b';
        } else if (inToday) {
          const inMin = toMin(empStats.lastCheckIn);
          const shiftStartMin = currentShift && currentShift.start ? toMin(currentShift.start) : null;
          const grace = (cfg.policy && cfg.policy.gracePeriodInMinutes) || 0;
          if (shiftStartMin !== null && inMin > shiftStartMin + grace) {
            statusCode = 'LATE';
            statusLabel = `Trễ giờ (${inMin - shiftStartMin}p)`;
            statusColor = '#f43f5e';
          } else {
            statusCode = 'ON_TIME';
            statusLabel = 'Đúng giờ';
            statusColor = '#10b981';
          }
        }

        empStats.attendanceStatus = {
          code: statusCode,
          label: statusLabel,
          color: statusColor,
          shiftName: currentShift ? currentShift.name : '',
          shiftTime: currentShift ? `${currentShift.start} - ${currentShift.end}` : '',
          todayShifts: emp.todayShifts || []
        };
      }

      const dow = String(weekdayOf(Date.now()));
      return send(res, 200, {
        ok: true,
        stats: empStats,
        employees: (data.employees || []).map(e => ({
          id: e.id,
          name: e.name,
          avatar: e.avatar || '',
          hasFaceProfile: Boolean(e.faceDescriptor && e.faceDescriptor.length === 128),
          faceStatus: e.faceStatus || (e.faceDescriptor ? 'APPROVED' : 'NONE'),
          todayShiftId: canViewEmpDetails && e.id === empId && e.weeklySchedule ? e.weeklySchedule[dow] || '' : '',
          todayShifts: canViewEmpDetails && e.id === empId ? e.todayShifts || [] : [],
          schedDate: canViewEmpDetails && e.id === empId ? e.schedDate || '' : '',
          branchIds: e.branchIds || []
        })),
        shifts: cfg.shifts || [],
        branches: cfg.branches || [],
        version: SERVER_VERSION
      });
    }

    if (url.pathname === '/api/employees') {
      return send(res, 200, { ok: true, employees: (data.employees || []).map(e => ({ id: e.id, name: e.name })) });
    }

    if (url.pathname === '/api/request' && req.method === 'POST') {
      const b = await parseBody(req), emp = (data.employees || []).find(e => e.id === b.empId);
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      const ae = authDevice(emp, b); if (ae) return send(res, ae.code, { ok: false, error: ae.error });
      const okT = x => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x || '')), d0 = String(b.date || '');
      const diff = isValidCalendarDate(d0) ? calendarDayDifference(dayOf(Date.now()), d0) : NaN;
      if (!Number.isFinite(diff) || diff < 0 || diff > 7) return send(res, 400, { ok: false, error: 'Chỉ bổ sung trong 7 ngày gần đây, không chọn ngày tương lai.' });
      if (!okT(b.timeIn) || (b.timeOut && !okT(b.timeOut))) return send(res, 400, { ok: false, error: 'Giờ không hợp lệ.' });
      if (String(b.reason || '').trim().length < 5) return send(res, 400, { ok: false, error: 'Hãy nhập lý do (tối thiểu 5 ký tự).' });
      if ((data.requests || []).filter(x => x.empId === emp.id && x.status === 'PENDING').length >= 5) return send(res, 429, { ok: false, error: 'Bạn đang có quá nhiều yêu cầu chờ duyệt.' });
      const r = { id: uuid(), empId: emp.id, date: d0, timeIn: b.timeIn, timeOut: b.timeOut || '', reason: String(b.reason).trim().slice(0, 200), ts: Date.now(), status: 'PENDING', msg: '' };
      (data.requests = data.requests || []).push(r); saveDb(); return send(res, 200, { ok: true, id: r.id });
    }
    if (url.pathname === '/api/my-requests') {
      const emp = (data.employees || []).find(e => e.id === url.searchParams.get('empId'));
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      const ae = authDevice(emp, { deviceId: url.searchParams.get('deviceId') });
      if (ae) return send(res, ae.code, { ok: false, error: ae.error });
      return send(res, 200, { ok: true, requests: (data.requests || []).filter(x => x.empId === emp.id).slice(-8).reverse().map(x => ({ date: x.date, timeIn: x.timeIn, timeOut: x.timeOut, reason: x.reason, status: x.status, msg: x.msg })) });
    }
    if (url.pathname === '/api/my-advances') {
      const emp = (data.employees || []).find(e => e.id === url.searchParams.get('empId'));
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      const ae = authDevice(emp, { deviceId: url.searchParams.get('deviceId') });
      if (ae) return send(res, ae.code, { ok: false, error: ae.error });
      const month = monthOf(Date.now()), estimate = emp.monthlyPayEstimate;
      const salaryEstimate = estimate && estimate.month === month && Number.isFinite(Number(estimate.net)) ? Math.max(0, Math.round(Number(estimate.net))) : 0;
      const limit = Math.floor(salaryEstimate * 0.5);
      const requests = (data.advanceRequests || []).filter(item => item.empId === emp.id && item.month === month);
      const activeRequests = requests.filter(item => item.status === 'PENDING' || item.status === 'APPROVED');
      const totalRequested = activeRequests.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const remaining = Math.max(0, limit - totalRequested);
      const requestCount = requests.length;
      let message = '';
      if (!estimate || estimate.month !== month) message = 'Hạn mức tháng này chưa được đồng bộ từ HRM.';
      else if (Number(dayOf(Date.now()).slice(-2)) > 25) message = 'Đã qua ngày chốt lương 25, không nhận yêu cầu ứng lương.';
      else if (requestCount >= 3) message = 'Đã đạt tối đa 3 yêu cầu ứng lương trong tháng.';
      else if (remaining < 1) message = 'Đã sử dụng hết hạn mức ứng lương tháng này.';
      return send(res, 200, {
        ok: true, month, salaryEstimate, limit, totalRequested, remaining, requestCount,
        canRequest: Boolean(estimate && estimate.month === month && Number(dayOf(Date.now()).slice(-2)) <= 25 && requestCount < 3 && remaining > 0),
        message,
        requests: requests.slice().sort((a, b) => b.ts - a.ts).map(item => ({ id: item.id, amount: item.amount, reason: item.reason, status: item.status, msg: item.msg || '', ts: item.ts }))
      });
    }
    if (url.pathname === '/api/advance-request' && req.method === 'POST') {
      const b = await parseBody(req), emp = (data.employees || []).find(e => e.id === b.empId);
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      const ae = authDevice(emp, b);
      if (ae) return send(res, ae.code, { ok: false, error: ae.error });
      const amount = Number(b.amount), month = monthOf(Date.now()), estimate = emp.monthlyPayEstimate;
      if (!Number.isSafeInteger(amount) || amount <= 0) return send(res, 400, { ok: false, error: 'Số tiền ứng phải là số nguyên dương (VND).' });
      if (Number(dayOf(Date.now()).slice(-2)) > 25) return send(res, 400, { ok: false, error: 'Đã qua ngày chốt lương 25, không nhận yêu cầu ứng lương.' });
      if (!estimate || estimate.month !== month || !Number.isFinite(Number(estimate.net))) return send(res, 409, { ok: false, error: 'Hạn mức tháng này chưa được đồng bộ từ HRM. Vui lòng liên hệ quản lý.' });
      const salaryEstimate = Math.max(0, Math.round(Number(estimate.net)));
      const monthRequests = (data.advanceRequests || []).filter(item => item.empId === emp.id && item.month === month);
      if (monthRequests.length >= 3) return send(res, 409, { ok: false, error: 'Đã đạt tối đa 3 yêu cầu ứng lương trong tháng.' });
      const requests = monthRequests.filter(item => item.status === 'PENDING' || item.status === 'APPROVED');
      const limit = Math.floor(salaryEstimate * 0.5);
      const used = requests.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      if (amount > limit - used) return send(res, 409, { ok: false, error: `Số tiền vượt hạn mức còn lại ${Math.max(0, limit - used).toLocaleString('vi-VN')} VND.` });
      const request = {
        id: uuid(), empId: emp.id, month, amount,
        salaryEstimate: salaryEstimate,
        reason: String(b.reason || '').trim().slice(0, 160),
        ts: Date.now(), status: 'PENDING', msg: '', imported: false
      };
      (data.advanceRequests = data.advanceRequests || []).push(request);
      saveDb();
      return send(res, 200, { ok: true, id: request.id });
    }
    if (url.pathname === '/api/request-status') {
      const r = (data.requests || []).find(x => x.id === url.searchParams.get('id'));
      return send(res, 200, r ? { ok: true, status: r.status, msg: r.msg || '' } : { ok: false });
    }

    if (url.pathname === '/api/schedule-preference') {
      const role = getRole();
      if (req.method === 'POST') {
        const b = await parseBody(req);
        const emp = (data.employees || []).find(e => e.id === b.empId);
        if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
        // [FIX A7] Chỉ đúng điện thoại của nhân viên (hoặc quản lý) mới được đặt lịch OFF
        const authError = selfAuthError(role, emp, b.deviceId);
        if (authError) return send(res, authError.code, { ok: false, error: authError.error });
        data.schedulePreferences = data.schedulePreferences || [];
        const incoming = (Array.isArray(b.preferences) ? b.preferences : [])
          .filter(x => x && typeof x === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ''))).slice(0, 62);
        const dateSet = new Set(incoming.map(x => x.date));
        data.schedulePreferences = data.schedulePreferences.filter(x => !(x.empId === emp.id && dateSet.has(x.date)));
        incoming.forEach(it => {
          data.schedulePreferences.push({
            id: uuid(),
            empId: emp.id,
            empName: emp.name,
            date: it.date,
            status: it.status || 'AVAILABLE',
            shiftPreference: it.shiftPreference || 'ALL',
            note: String(it.note || '').slice(0, 150),
            updatedAt: Date.now()
          });
        });
        saveDb();
        return send(res, 200, { ok: true, count: incoming.length });
      }
      const empId = url.searchParams.get('empId');
      // [FIX A7] Xem toàn bộ nhân viên => chỉ quản lý/admin; xem của một người => đúng điện thoại
      if (!empId) {
        if (role === 'GUEST') return send(res, 401, { ok: false, error: 'Cần chỉ định nhân viên hoặc đăng nhập quản lý.' });
        return send(res, 200, { ok: true, preferences: data.schedulePreferences || [] });
      }
      const empQ = (data.employees || []).find(e => e.id === empId);
      if (!empQ) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      const authError = selfAuthError(role, empQ, url.searchParams.get('deviceId'));
      if (authError) return send(res, authError.code, { ok: false, error: authError.error });
      return send(res, 200, { ok: true, preferences: (data.schedulePreferences || []).filter(x => x.empId === empId) });
    }

    if (url.pathname === '/api/status') {
      const it = (data.inbox || []).find(x => x.id === url.searchParams.get('id'));
      return send(res, 200, it ? { ok: true, status: it.status, msg: it.msg || '' } : { ok: false });
    }

    if (url.pathname === '/api/my-schedule') {
      const empId = url.searchParams.get('empId');
      const emp = (data.employees || []).find(e => e.id === empId);
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      // [FIX A7] Lịch + giờ chấm công là dữ liệu cá nhân: cần đúng điện thoại đã đăng ký (hoặc token quản lý)
      const authError = selfAuthError(getRole(), emp, url.searchParams.get('deviceId'));
      if (authError) return send(res, authError.code, { ok: false, error: authError.error });

      const now = Date.now();
      const todayStr = dayOf(now);
      const day = weekdayOf(now);
      const diffToMonday = (day === 0 ? -6 : 1) - day;
      const mondayThisWeek = addCalendarDays(todayStr, diffToMonday);

      const WD_LABELS = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ Nhật'];

      const buildWeek = (startMon) => {
        const days = [];
        for (let i = 0; i < 7; i++) {
          const dateStr = addCalendarDays(startMon, i);
          const [, m, dt] = dateStr.split('-');
          const isToday = dateStr === todayStr;

          let scheduledShifts = (data.roster || []).filter(r => r.empId === emp.id && r.date === dateStr && r.status === 'SCHEDULED').map(r => {
            const sh = (Array.isArray(cfg.shifts) ? cfg.shifts : []).find(s => s.id === r.shiftId) || {};
            return {
              id: r.shiftId,
              name: sh.name || r.shiftId,
              start: sh.startTime || '',
              end: sh.endTime || '',
              note: r.note || ''
            };
          });

          if (!scheduledShifts.length && isToday && Array.isArray(emp.todayShifts) && emp.todayShifts.length) {
            scheduledShifts = emp.todayShifts;
          }

          const pref = (data.schedulePreferences || []).find(p => p.empId === emp.id && p.date === dateStr);
          const isOffPref = pref && pref.status === 'OFF';

          const recs = (data.inbox || []).filter(r => r.empId === emp.id && r.status === 'DONE' && dayOf(r.ts) === dateStr);
          const inRec = recs.find(r => r.action === 'in');
          const outRec = recs.find(r => r.action === 'out');
          const checkIn = inRec ? (inRec.timeStr || timeOf(inRec.ts)) : null;
          const checkOut = outRec ? (outRec.timeStr || timeOf(outRec.ts)) : null;

          let statusCode = 'NO_SHIFT', statusLabel = 'Không có ca', statusColor = '#94a3b8';

          if (isOffPref) {
            statusCode = 'OFF';
            statusLabel = 'Đã xin nghỉ OFF';
            statusColor = '#a855f7';
          } else if (scheduledShifts.length > 0) {
            statusCode = 'SCHEDULED';
            statusLabel = 'Đã xếp lịch';
            statusColor = '#38bdf8';
          }

          if (checkIn) {
            const firstShift = scheduledShifts[0];
            const inMin = toMin(checkIn);
            const startMin = firstShift && firstShift.start ? toMin(firstShift.start) : null;
            const grace = (cfg.policy && cfg.policy.gracePeriodInMinutes) || 0;
            const isLate = startMin !== null && inMin > startMin + grace;

            if (checkOut) {
              statusCode = isLate ? 'LATE' : 'ON_TIME';
              statusLabel = isLate ? `Trễ giờ (${inMin - startMin}p)` : 'Đúng giờ';
              statusColor = isLate ? '#f43f5e' : '#10b981';
            } else {
              if (isToday) {
                statusCode = isLate ? 'LATE' : 'IN_PROGRESS';
                statusLabel = isLate ? `Trễ (${checkIn}) • Đang ca` : 'Đang trong ca';
                statusColor = isLate ? '#f43f5e' : '#0284c7';
              } else {
                statusCode = 'FORGOT';
                statusLabel = 'Quên ra ca';
                statusColor = '#f59e0b';
              }
            }
          }

          days.push({
            date: dateStr,
            dayLabel: WD_LABELS[i],
            shortDate: `${dt}/${m}`,
            isToday,
            isPast: dateStr < todayStr,
            isFuture: dateStr > todayStr,
            shifts: scheduledShifts,
            checkIn,
            checkOut,
            isOffPref,
            offNote: (pref && pref.note) || '',
            statusCode,
            statusLabel,
            statusColor
          });
        }
        return days;
      };

      const mondayNextWeek = addCalendarDays(mondayThisWeek, 7);

      return send(res, 200, {
        ok: true,
        empId: emp.id,
        empName: emp.name,
        currentWeek: buildWeek(mondayThisWeek),
        nextWeek: buildWeek(mondayNextWeek)
      });
    }

    if (url.pathname === '/api/change-pin' && req.method === 'POST') {
      const b = await parseBody(req);
      const emp = (data.employees || []).find(e => e.id === b.empId);
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      // [FIX A4] Khóa tạm khi nhập sai nhiều lần
      if (isLocked(emp.id, ip)) return send(res, 429, { ok: false, error: 'Nhập sai quá nhiều lần. Thử lại sau 15 phút hoặc nhờ quản lý đặt lại mật khẩu.' });
      const oldPin = String(b.oldPin || '').trim();
      const newPin = String(b.newPin || '').trim();
      if (!/^\d{4,6}$/.test(newPin)) return send(res, 400, { ok: false, error: 'Mật khẩu mới phải từ 4 đến 6 chữ số.' });
      // [FIX A3] Không còn đường "PIN rỗng => đổi không cần mật khẩu cũ"
      if (!emp.pin) return send(res, 403, { ok: false, error: 'Tài khoản chưa có mật khẩu. Hãy dùng chức năng quên mật khẩu (xác thực khuôn mặt) hoặc nhờ quản lý đặt mật khẩu.' });
      if (!safeEq(emp.pin, oldPin)) { noteFail(emp.id, ip); return send(res, 400, { ok: false, error: 'Mật khẩu cũ không chính xác.' }); }
      clearFail(emp.id, ip);
      emp.pin = newPin;
      saveDb();
      return send(res, 200, { ok: true, msg: 'Đổi mật khẩu thành công.' });
    }

    if (url.pathname === '/api/verify-face-reset-pin' && req.method === 'POST') {
      const b = await parseBody(req);
      const emp = (data.employees || []).find(e => e.id === b.empId);
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      if (isLocked(emp.id, ip)) return send(res, 429, { ok: false, error: 'Thử quá nhiều lần. Vui lòng thử lại sau 15 phút hoặc nhờ quản lý đặt lại mật khẩu.' });

      const st = emp.faceStatus || (emp.faceDescriptor && emp.faceDescriptor.length === 128 ? 'APPROVED' : 'NONE');
      if (st !== 'APPROVED' || (!emp.faceDescriptor && (!emp.faceDescriptors || !emp.faceDescriptors.length))) {
        return send(res, 400, { ok: false, error: 'Bạn chưa có dữ liệu khuôn mặt đã duyệt trên hệ thống. Vui lòng nhờ Quản lý reset mật khẩu.' });
      }

      const clientDescriptor = isDesc128(b.descriptor) ? b.descriptor : null;
      if (!clientDescriptor) return send(res, 400, { ok: false, error: 'Không nhận diện được khuôn mặt hợp lệ. Vui lòng quét lại chính diện.' });

      const threshold = cfg.faceThreshold || 0.48;
      const refs = (emp.faceDescriptors && emp.faceDescriptors.length) ? emp.faceDescriptors : [emp.faceDescriptor];
      const distance = Math.min(...refs.map(r => calcEuclideanDistance(r, clientDescriptor)));
      const faceVerified = distance <= threshold;
      const sim = Math.max(0, Math.round((1 - distance) * 100));

      if (!faceVerified) {
        noteFail(emp.id, ip);
        return send(res, 403, { ok: false, error: `Xác thực khuôn mặt thất bại (độ khớp chỉ ${sim}%)! Chỉ chính chủ nhân viên mới được phép đặt lại mật khẩu.` });
      }

      const newPin = String(b.newPin || '0000').trim();
      if (!/^\d{4,6}$/.test(newPin)) return send(res, 400, { ok: false, error: 'Mật khẩu phải từ 4 đến 6 chữ số.' });
      clearFail(emp.id, ip);
      emp.pin = newPin;
      saveDb();

      return send(res, 200, { ok: true, pin: emp.pin, msg: `Đã xác thực khuôn mặt thành công (${sim}%)! Mật khẩu đã được đặt lại thành ${emp.pin}.` });
    }

    if (url.pathname === '/api/checkin' && req.method === 'POST') {
      const b = await parseBody(req);
      const emp = (data.employees || []).find(e => e.id === b.empId);
      if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
      const dev = String(b.deviceId || '').slice(0, 64);
      if (!dev) return send(res, 400, { ok: false, error: 'Thiếu mã thiết bị, hãy tải lại trang.' });
      if (b.action !== 'in' && b.action !== 'out') return send(res, 400, { ok: false, error: 'Hành động chấm công không hợp lệ.' });
      const branchId = String(b.branchId || '').trim();
      const branch = (cfg.branches || []).find(item => item.id === branchId);
      if (!branch) return send(res, 400, { ok: false, error: 'Vui lòng chọn chi nhánh chấm công hợp lệ.' });
      const activeScan = [...(data.inbox || [])].reverse().find(item => item.empId === emp.id && item.status === 'DONE' && !item.appRejected);
      const closingActiveBranch = b.action === 'out' && activeScan && activeScan.action === 'in' && activeScan.branchId === branchId && Date.now() - activeScan.ts < 20 * 3600e3;
      if (!(emp.branchIds || []).includes(branchId) && !closingActiveBranch) return send(res, 403, { ok: false, error: 'Bạn chưa được phân công làm việc tại chi nhánh này.' });

      // [FIX A6] Giới hạn tần suất theo IP (chống làm đầy đĩa bằng ảnh rác)
      if (rateHit('checkin|' + ip, 20, 10 * 60e3)) return send(res, 429, { ok: false, error: 'Gửi quá nhiều lần, thử lại sau ít phút.' });

      if (typeof b.photo !== 'string' || !b.photo.startsWith('data:image/')) return send(res, 400, { ok: false, error: 'Thiếu ảnh khuôn mặt.' });
      const ds = (Array.isArray(b.descriptors) ? b.descriptors : [b.descriptor]).filter(isDesc128).slice(0, 3);
      const clientDescriptor = ds[0] || null;
      if (!clientDescriptor) return send(res, 400, { ok: false, error: 'Đặc trưng khuôn mặt không hợp lệ.' });

      const photoMatches = b.photo.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
      if (!photoMatches) return send(res, 400, { ok: false, error: 'Ảnh không hợp lệ.' });
      const imgBuffer = Buffer.from(photoMatches[2], 'base64');
      const ph = crypto.createHash('sha256').update(imgBuffer).digest('hex'); data.photoHashes = data.photoHashes || {};
      if (data.photoHashes[ph]) return send(res, 400, { ok: false, error: 'Ảnh này đã được dùng trước đó. Hãy chụp ảnh mới.' });

      const filename = `${emp.id}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.jpg`;
      // [FIX A6] Chỉ ghi ảnh + đánh dấu hash SAU KHI mọi kiểm tra đã qua (không còn ảnh mồ côi khi bị từ chối)
      const savePhoto = () => { data.photoHashes[ph] = Date.now(); fs.writeFileSync(path.join(PHOTOS_DIR, filename), imgBuffer); };

      const timeStr = timeOf(Date.now());
      const threshold = cfg.faceThreshold || 0.48;
      const st = emp.faceStatus || (emp.faceDescriptor && emp.faceDescriptor.length === 128 ? 'APPROVED' : 'NONE');
      let status = 'REJECTED', msg = '', faceVerified = false, distance = null, rule = null;
      if (st === 'NONE' || st === 'PENDING') {
        // Đăng ký khuôn mặt lần đầu: KHÔNG tự chấp nhận, chờ quản lý duyệt (tránh người khác đăng ký thay)
        enrolls[ip] = (enrolls[ip] || []).filter(x => Date.now() - x < 3600e3); if (enrolls[ip].length >= 8) return send(res, 429, { ok: false, error: 'Gửi đăng ký quá nhiều lần, thử lại sau.' }); enrolls[ip].push(Date.now());
        const keep = st === 'PENDING' && emp.pendingFace && ds.length < (emp.pendingFace.descriptors || []).length; // không để 1 ảnh lẻ ghi đè bộ 3 mẫu đang chờ duyệt
        savePhoto();
        if (!keep) emp.pendingFace = { descriptor: clientDescriptor, descriptors: ds, deviceId: dev, photoRef: `/photos/${filename}`, ts: Date.now() };
        emp.faceStatus = 'PENDING'; status = 'ENROLL';
        msg = keep ? 'Ảnh đăng ký của bạn đang chờ quản lý duyệt, chưa thể chấm công.' : `Đã gửi ảnh đăng ký lúc ${timeStr}. Chờ quản lý duyệt rồi mới chấm công được.`;
      } else {
        if (emp.deviceId && emp.deviceId !== dev) return send(res, 403, { ok: false, error: 'Điện thoại này chưa được đăng ký cho bạn. Nhờ quản lý gỡ thiết bị cũ rồi thử lại.' });
        const refs = (emp.faceDescriptors && emp.faceDescriptors.length) ? emp.faceDescriptors : [emp.faceDescriptor];
        distance = Math.min(...refs.map(r => calcEuclideanDistance(r, clientDescriptor)));
        faceVerified = distance <= threshold;
        status = faceVerified ? 'DONE' : 'REJECTED';
        if (faceVerified && !emp.deviceId) emp.deviceId = dev;
        rule = faceVerified ? validateScan(emp, b.action, branchId) : null;
        if (rule) status = 'REJECTED';
        savePhoto();
        const sim = Math.max(0, Math.round((1 - distance) * 100));
        msg = rule ? rule : faceVerified ? `${b.action === 'in' ? 'VÀO CA' : 'RA CA'} thành công lúc ${timeStr} (khớp ${sim}%)` : `Từ chối: Khuôn mặt không khớp (${sim}%)!`;
      }
      const simPercent = distance !== null ? Math.max(0, Math.round((1 - distance) * 100)) : 0;
      const record = { id: uuid(), empId: emp.id, action: b.action, branchId, photo: `/photos/${filename}`, ts: Date.now(), timeStr, ip, similarity: simPercent, faceVerified, faceFail: status === 'REJECTED' && !rule, status, msg, imported: status !== 'DONE' };

      data.inbox.push(record);
      saveDb();

      return send(res, 200, { ok: true, id: record.id, timeStr, status: record.status, msg: record.msg });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      const role = getRole();
      if (role === 'GUEST') return send(res, 401, { ok: false, error: 'Token không hợp lệ hoặc chưa đăng nhập.' });

      if (url.pathname === '/api/admin/hrm-db') {
        if (role !== 'ADMIN') return send(res, 403, { ok: false, error: 'Chỉ tài khoản ADMIN được truy cập dữ liệu HRM dùng chung.' });
        if (req.method === 'GET') {
          return send(res, 200, {
            ok: true,
            exists: Boolean(sharedHrm),
            revision: sharedHrm ? sharedHrm.revision : 0,
            updatedAt: sharedHrm ? sharedHrm.updatedAt : null,
            db: sharedHrm ? sharedHrm.db : null
          });
        }
        if (req.method === 'POST') {
          const b = await parseBody(req, MAX_HRM_DB_BYTES);
          if (!Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 0) {
            return send(res, 400, { ok: false, error: 'Phiên bản dữ liệu HRM không hợp lệ.' });
          }
          if (!isValidHrmDatabase(b.db)) {
            return send(res, 400, { ok: false, error: 'Cấu trúc dữ liệu HRM không hợp lệ; máy chủ chưa thay đổi dữ liệu.' });
          }
          const currentRevision = sharedHrm ? sharedHrm.revision : 0;
          if (b.expectedRevision !== currentRevision) {
            return send(res, 409, { ok: false, error: 'Dữ liệu trên VPS đã thay đổi ở thiết bị khác. Hãy tải bản VPS hoặc xử lý xung đột trước khi lưu.', revision: currentRevision });
          }
          const nextDb = JSON.parse(JSON.stringify(b.db));
          if (nextDb.phone && typeof nextDb.phone === 'object') delete nextDb.phone.adminToken;
          const next = { revision: currentRevision + 1, updatedAt: new Date().toISOString(), db: nextDb };
          if (fs.existsSync(HRM_DB_FILE)) {
            fs.copyFileSync(HRM_DB_FILE, HRM_DB_FILE + '.bak');
            fs.chmodSync(HRM_DB_FILE + '.bak', 0o600);
          }
          const tempFile = HRM_DB_FILE + '.tmp';
          fs.writeFileSync(tempFile, JSON.stringify(next), { mode: 0o600 });
          fs.chmodSync(tempFile, 0o600);
          fs.renameSync(tempFile, HRM_DB_FILE);
          fs.chmodSync(HRM_DB_FILE, 0o600);
          sharedHrm = next;
          return send(res, 200, { ok: true, revision: next.revision, updatedAt: next.updatedAt });
        }
        return send(res, 405, { ok: false, error: 'Phương thức không được hỗ trợ.' });
      }

      if (url.pathname === '/api/admin/config') {
        if (req.method === 'POST') {
          const b = await parseBody(req);
          const branchOnlyUpdate = role === 'MANAGER' && Object.keys(b).length === 1 && b.branches !== undefined;
          if (role !== 'ADMIN' && !branchOnlyUpdate) return send(res, 403, { ok: false, error: 'Chỉ tài khoản ADMIN mới được quyền đổi cấu hình quy chế.' });
          if (b.shifts !== undefined && !Array.isArray(b.shifts)) return send(res, 400, { ok: false, error: 'shifts phải là một mảng.' });
          if (b.branches !== undefined) {
            if (!Array.isArray(b.branches) || !b.branches.length) return send(res, 400, { ok: false, error: 'branches phải là mảng có ít nhất một chi nhánh.' });
            const branches = b.branches.map(branch => ({
              id: String(branch && branch.id || '').trim(),
              name: String(branch && branch.name || '').trim(),
              address: String(branch && branch.address || '').trim()
            }));
            if (branches.some(branch => !/^[A-Za-z0-9_-]{1,64}$/.test(branch.id) || !branch.name || branch.name.length > 120 || branch.address.length > 200)) {
              return send(res, 400, { ok: false, error: 'Thông tin chi nhánh không hợp lệ.' });
            }
            if (new Set(branches.map(branch => branch.id)).size !== branches.length) return send(res, 400, { ok: false, error: 'Mã chi nhánh không được trùng.' });
            const nextIds = new Set(branches.map(branch => branch.id));
            if ((data.employees || []).some(emp => (Array.isArray(emp.branchIds) ? emp.branchIds : []).some(id => !nextIds.has(id)))) {
              return send(res, 409, { ok: false, error: 'Không thể xóa chi nhánh đang được gán cho nhân sự.' });
            }
            if ((data.inbox || []).some(item => item.status === 'DONE' && item.branchId && !nextIds.has(item.branchId))) {
              return send(res, 409, { ok: false, error: 'Không thể xóa chi nhánh đã có dữ liệu chấm công.' });
            }
            cfg.branches = branches;
            data.branches = branches;
          }
          if (b.shifts) cfg.shifts = b.shifts;
          if (b.policy) cfg.policy = b.policy;
          if (b.faceThreshold !== undefined) { const v = Number(b.faceThreshold); if (v >= 0.3 && v <= 0.7) cfg.faceThreshold = v; }
          saveConfig();
          if (b.branches !== undefined) saveDb();
          return send(res, 200, { ok: true });
        }
        if (role !== 'ADMIN') return send(res, 403, { ok: false, error: 'Chỉ tài khoản ADMIN mới được xem cấu hình quy chế.' });
        return send(res, 200, { ok: true, config: { shifts: cfg.shifts, policy: cfg.policy, faceThreshold: cfg.faceThreshold, branches: cfg.branches } });
      }

      if (url.pathname === '/api/admin/employees') {
        if (req.method === 'GET') {
          return send(res, 200, {
            ok: true,
            employees: (data.employees || []).map(e => ({ id: e.id, name: e.name, pin: e.pin || '0000', deviceId: e.deviceId || '', branchIds: e.branchIds || [] }))
          });
        }
        if (req.method === 'POST') {
          const b = await parseBody(req, BIG_BODY);
          if (!Array.isArray(b.employees)) return send(res, 400, { ok: false, error: 'employees phải là một mảng.' });
          const incoming = b.employees.filter(e => e && e.id !== undefined && e.id !== null && String(e.id) !== '');
          const oldMap = new Map((data.employees || []).map(e => [e.id, e]));

          data.employees = incoming.map(e => {
            const old = oldMap.get(String(e.id)) || {};
            const assignedBranchIds = [...new Set((Array.isArray(e.branchIds) ? e.branchIds : old.branchIds || []).map(String).filter(id => (cfg.branches || []).some(branch => branch.id === id)))];
            return {
              id: String(e.id),
              name: String(pick(e.name, old.name, '')),
              pin: String(pick(e.pin, old.pin, '')).trim() || '0000', // [FIX A3] không để PIN rỗng
              department: String(pick(e.department, old.department, '')).trim(),
              branchIds: assignedBranchIds.length ? assignedBranchIds : (cfg.branches.length ? [cfg.branches[0].id] : []),
              deviceId: old.deviceId || '',
              avatar: e.avatar || old.avatar || '',
              photoRef: old.photoRef || '',
              faceDescriptor: old.faceDescriptor || null,
              faceDescriptors: old.faceDescriptors || null,
              todayShifts: pick(e.todayShifts, old.todayShifts, null),
              schedDate: e.schedDate || old.schedDate || '',
              faceStatus: old.faceStatus || (old.faceDescriptor ? 'APPROVED' : 'NONE'),
              pendingFace: old.pendingFace || null,
              monthlyPayEstimate: e.monthlyPayEstimate && /^\d{4}-\d{2}$/.test(String(e.monthlyPayEstimate.month || '')) && Number.isFinite(Number(e.monthlyPayEstimate.net))
                ? { month: String(e.monthlyPayEstimate.month), net: Math.max(0, Math.round(Number(e.monthlyPayEstimate.net))) }
                : old.monthlyPayEstimate || null,
              weeklySchedule: pick(e.weeklySchedule, old.weeklySchedule, {}), // [FIX A9] trước đây old.weeklySchedule || ... nên không bao giờ cập nhật
              lateCount: pick(e.lateCount, old.lateCount, 0),
              overtimeCount: pick(e.overtimeCount, old.overtimeCount, 0),
              penaltyCount: pick(e.penaltyCount, old.penaltyCount, 0),
              advanceCount: pick(e.advanceCount, old.advanceCount, 0)
            };
          });

          saveDb();
          return send(res, 200, { ok: true, count: data.employees.length });
        }
      }

      if (url.pathname === '/api/admin/reset-pin' && req.method === 'POST') {
        const b = await parseBody(req);
        const emp = (data.employees || []).find(e => e.id === b.empId || e.id === b.id);
        if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
        const pin = String(b.pin || '0000').trim();
        if (!/^\d{4,6}$/.test(pin)) return send(res, 400, { ok: false, error: 'Mật khẩu phải từ 4 đến 6 chữ số.' });
        emp.pin = pin;
        delete pinFails['e|' + emp.id];
        Object.keys(pinFails).forEach(k => { if (k.startsWith('i|' + emp.id + '|')) delete pinFails[k]; });
        saveDb();
        return send(res, 200, { ok: true, pin: emp.pin, msg: `Đã đặt lại mật khẩu của ${emp.name} về ${pin}.` });
      }

      if (url.pathname === '/api/admin/requests') {
        return send(res, 200, { ok: true, requests: (data.requests || []).filter(x => x.status === 'PENDING') });
      }
      if (url.pathname === '/api/admin/advance-requests') {
        return send(res, 200, { ok: true, requests: (data.advanceRequests || []).filter(item => item.status === 'PENDING').slice().sort((a, b) => a.ts - b.ts) });
      }
      if (url.pathname === '/api/admin/advance-requests/decide' && req.method === 'POST') {
        const b = await parseBody(req);
        const request = (data.advanceRequests || []).find(item => item.id === b.id);
        if (!request) return send(res, 404, { ok: false, error: 'Không tìm thấy yêu cầu ứng lương.' });
        if (request.status !== 'PENDING') return send(res, 409, { ok: false, error: 'Yêu cầu này đã được xử lý.' });
        const emp = (data.employees || []).find(item => item.id === request.empId);
        if (!emp) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
        if (b.approve !== true && b.approve !== false) return send(res, 400, { ok: false, error: 'Thiếu quyết định duyệt hoặc từ chối.' });
        if (b.approve) {
          const estimate = emp.monthlyPayEstimate;
          const approvalEstimate = estimate && estimate.month === request.month
            ? Math.max(0, Number(estimate.net))
            : Math.max(0, Number(request.salaryEstimate) || 0);
          if (!approvalEstimate) return send(res, 409, { ok: false, error: 'Không có ước tính lương hợp lệ để xác nhận yêu cầu.' });
          const active = (data.advanceRequests || []).filter(item => item.empId === emp.id && item.month === request.month && (item.status === 'PENDING' || item.status === 'APPROVED'));
          const total = active.reduce((sum, item) => sum + Number(item.amount || 0), 0);
          if (total > Math.floor(approvalEstimate * 0.5)) return send(res, 409, { ok: false, error: 'Tổng yêu cầu đã vượt 50% lương thực nhận ước tính; hãy từ chối yêu cầu này.' });
          request.status = 'APPROVED';
          request.msg = 'Yêu cầu ứng lương đã được duyệt.';
        } else {
          request.status = 'REJECTED';
          request.msg = String(b.reason || 'Yêu cầu ứng lương đã bị từ chối.').trim().slice(0, 200);
        }
        request.decidedAt = Date.now();
        request.imported = false;
        saveDb();
        return send(res, 200, { ok: true, request });
      }
      if (url.pathname === '/api/admin/advances') {
        return send(res, 200, {
          ok: true,
          advances: (data.advanceRequests || []).filter(item => item.status === 'APPROVED' && !item.imported).map(item => ({
            id: item.id, empId: item.empId, month: item.month, amount: item.amount,
            reason: item.reason, date: dayOf(item.ts), ts: item.ts
          }))
        });
      }
      if (url.pathname === '/api/admin/advances/ack' && req.method === 'POST') {
        const b = await parseBody(req), item = (data.advanceRequests || []).find(x => x.id === b.id && x.status === 'APPROVED');
        if (item) { item.imported = true; saveDb(); }
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/admin/schedule-preferences') {
        return send(res, 200, { ok: true, preferences: data.schedulePreferences || [] });
      }
      if (url.pathname === '/api/admin/roster' && req.method === 'POST') {
        const b = await parseBody(req, BIG_BODY);
        data.roster = Array.isArray(b.roster) ? b.roster : [];
        saveDb();
        return send(res, 200, { ok: true, count: data.roster.length });
      }
      if (url.pathname === '/api/admin/requests/ack' && req.method === 'POST') {
        const b = await parseBody(req), r = (data.requests || []).find(x => x.id === b.id);
        if (r) { r.status = b.ok ? 'DONE' : 'REJECTED'; r.msg = String(b.msg || ''); saveDb(); } return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/admin/alerts') {
        const T = '?t=' + encodeURIComponent(String(req.headers['x-admin-token'] || ''));
        return send(res, 200, { ok: true, alerts: (data.inbox || []).filter(x => (x.faceFail || x.appRejected) && !x.reviewed).slice(-20).reverse().map(x => ({ id: x.id, empId: x.empId, ts: x.ts, action: x.action, similarity: x.similarity, reason: x.faceFail ? 'Khuôn mặt không khớp' : (x.appMsg || 'App từ chối bản ghi'), photo: `${requestOrigin}${x.photo}${T}` })) });
      }
      if (url.pathname === '/api/admin/alerts/review' && req.method === 'POST') {
        const b = await parseBody(req), it = (data.inbox || []).find(x => x.id === b.id); if (it) { it.reviewed = true; saveDb(); } return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/admin/faces') {
        const T = '?t=' + encodeURIComponent(String(req.headers['x-admin-token'] || ''));
        return send(res, 200, { ok: true, faces: (data.employees || []).map(e => ({ id: e.id, status: e.faceStatus || (e.faceDescriptor ? 'APPROVED' : 'NONE'), device: Boolean(e.deviceId), photo: e.photoRef ? `${requestOrigin}${e.photoRef}${T}` : '', pending: e.pendingFace ? `${requestOrigin}${e.pendingFace.photoRef}${T}` : '' })) });
      }
      if (url.pathname === '/api/admin/face' && req.method === 'POST') {
        const b = await parseBody(req), e = (data.employees || []).find(x => x.id === b.id);
        if (!e) return send(res, 404, { ok: false, error: 'Không tìm thấy nhân viên.' });
        if (b.op === 'approve' && e.pendingFace) { e.faceDescriptor = e.pendingFace.descriptor; e.faceDescriptors = e.pendingFace.descriptors || [e.pendingFace.descriptor]; if (e.pendingFace.deviceId) e.deviceId = e.pendingFace.deviceId; e.photoRef = e.pendingFace.photoRef; e.pendingFace = null; e.faceStatus = 'APPROVED'; }
        else if (b.op === 'reject') { e.pendingFace = null; e.faceStatus = e.faceDescriptor ? 'APPROVED' : 'NONE'; }
        else if (b.op === 'reset') { e.faceDescriptor = null; e.faceDescriptors = null; e.deviceId = ''; e.photoRef = ''; e.pendingFace = null; e.faceStatus = 'NONE'; }
        else if (b.op === 'unbind') { e.deviceId = ''; }
        else return send(res, 400, { ok: false, error: 'Thao tác không hợp lệ.' });
        saveDb(); return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/admin/inbox') {
        const items = (data.inbox || []).filter(item => !item.imported && item.status === 'DONE').map(item => ({
          ...item,
          photo: (item.photo && item.photo.startsWith('/photos/')) ? `${requestOrigin}${item.photo}` : item.photo
        }));
        return send(res, 200, { ok: true, items });
      }

      if (url.pathname === '/api/admin/ack' && req.method === 'POST') {
        const b = await parseBody(req);
        const it = (data.inbox || []).find(x => x.id === b.id);
        if (it) {
          it.imported = true; if (!b.ok) { it.appRejected = true; it.appMsg = String(b.msg || ''); }
          saveDb();
        }
        return send(res, 200, { ok: true });
      }
    }

    send(res, 404, { ok: false });
  } catch (err) {
    if (res.headersSent) { try { res.end(); } catch (_) { /* bỏ qua */ } return; }
    if (err && err.code === 'TOO_BIG') {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
      res.on('finish', () => req.destroy());
      return res.end(JSON.stringify({ ok: false, error: 'Dữ liệu gửi lên quá lớn.' }));
    }
    if (err instanceof SyntaxError) return send(res, 400, { ok: false, error: 'Dữ liệu JSON không hợp lệ.' });
    console.error('Lỗi xử lý:', err);
    send(res, 500, { ok: false, error: 'Lỗi xử lý hệ thống.' });
  }
};

let tlsOptions = null;
if (cfg.tlsCertFile || cfg.tlsKeyFile) {
  if (!cfg.tlsCertFile || !cfg.tlsKeyFile) {
    console.error('❌ Cần cấu hình đồng thời tlsCertFile và tlsKeyFile, hoặc để trống cả hai.');
    process.exit(1);
  }
  try {
    const certPath = path.isAbsolute(cfg.tlsCertFile) ? cfg.tlsCertFile : path.join(__dirname, cfg.tlsCertFile);
    const keyPath = path.isAbsolute(cfg.tlsKeyFile) ? cfg.tlsKeyFile : path.join(__dirname, cfg.tlsKeyFile);
    tlsOptions = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (e) {
    console.error('❌ Không đọc được chứng chỉ TLS:', e.message);
    process.exit(1);
  }
}
if (cfg.requireHttps && !tlsOptions) {
  console.error('❌ requireHttps đang bật nhưng chưa cấu hình tlsCertFile và tlsKeyFile. Server dừng để tránh truyền dữ liệu không mã hóa.');
  process.exit(1);
}

const server = tlsOptions
  ? https.createServer(tlsOptions, handleRequest)
  : http.createServer(handleRequest);

server.on('error', e => { console.error('❌ Không khởi động được server:', e.message); process.exit(1); });

server.listen(cfg.port, cfg.listenHost, () => {
  const ips = [].concat(...Object.values(os.networkInterfaces())).filter(i => (i.family === 'IPv4' || i.family === 4) && !i.internal).map(i => i.address);
  console.log('=================================================================');
  console.log(`  HỆ THỐNG QUẢN LÝ CHẤM CÔNG BR — PHÂN QUYỀN V${SERVER_VERSION}`);
  console.log(`  Lắng nghe tại ${cfg.listenHost}:${cfg.port}`);
  console.log('=================================================================');
  if (tlsOptions) {
    console.log(`🖥️ Giao diện HRM: https://<tên-máy-chủ-trong-chứng-chỉ>:${cfg.port}/`);
    console.log(`📱 Giao diện chấm công di động: https://<tên-máy-chủ-trong-chứng-chỉ>:${cfg.port}/chamcong`);
    ips.forEach(ip => console.log(`   Địa chỉ IP ${ip} chỉ dùng được nếu chứng chỉ có SAN cho IP này.`));
  }
  else console.warn('⚠️ TLS chưa bật: kết nối HTTP không mã hóa token/mã thiết bị. Cấu hình tlsCertFile và tlsKeyFile để bật HTTPS.');
  console.log('🔐 Token Admin/Quản lý không hiển thị trên console.');
  if (envAdminToken || envManagerToken) console.log('   Token được cung cấp qua biến môi trường và không được ghi vào config.json.');
  else console.log('   Token vẫn nằm trong config.json; dùng BRHRMG_ADMIN_TOKEN/BRHRMG_MANAGER_TOKEN để chuyển sang biến môi trường.');
  console.log('=================================================================');
  cleanOldPhotos();
  setInterval(cleanOldPhotos, 6 * 3600e3).unref();
  // Dọn bộ nhớ các bộ đếm giới hạn tần suất
  setInterval(() => {
    const now = Date.now();
    for (const m of [pinFails, hits, enrolls]) {
      for (const k of Object.keys(m)) {
        m[k] = m[k].filter(t => now - t < 3600e3);
        if (!m[k].length) delete m[k];
      }
    }
  }, 10 * 60e3).unref();
});
