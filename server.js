const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./src/db');
const { KNOWN_UNITS, KNOWN_WORKSHOPS, KNOWN_SERIES } = require('./src/constants');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'static')));

// ---------- ticket attachment uploads ----------

const TICKET_UPLOAD_DIR = path.join(__dirname, 'uploads', 'tickets');
fs.mkdirSync(TICKET_UPLOAD_DIR, { recursive: true });

const TICKET_ATTACHMENT_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx'];

// Browsers send multipart filenames as UTF-8, but multer/busboy decodes them as
// latin1, mangling non-ASCII names (e.g. Thai). Re-interpret the bytes to recover them.
function fixUploadedFilename(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

const ticketUpload = multer({
  storage: multer.diskStorage({
    destination: TICKET_UPLOAD_DIR,
    filename: (req, file, cb) => {
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 10)}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!TICKET_ATTACHMENT_EXTS.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    }
    cb(null, true);
  },
});

// ---------- user auth ----------

const SESSION_COOKIE = 'user_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Every permission a master admin can grant to a user. Keys are checked with req.can(key).
const PERMISSIONS = [
  { key: 'materials_manage', label: 'Materials Manage (add/edit/delete materials)' },
  { key: 'process_map', label: 'Process Mapping' },
  { key: 'transactions_manage', label: 'Transactions Manage (void/edit)' },
  { key: 'tickets_manage', label: 'Tickets Manage (resolve/delete)' },
  { key: 'dashboard_anomalies', label: 'Dashboard Anomalies' },
  { key: 'issue_backdate', label: 'Backdate Entry (Record Data)' },
];
const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

// token -> { id, username, is_master, permissions: Set<string> }, cleared on server restart.
const sessions = new Map();

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function parsePermissions(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return new Set(Array.isArray(arr) ? arr.filter((k) => PERMISSION_KEYS.has(k)) : []);
  } catch {
    return new Set();
  }
}

async function seedMasterAdmin() {
  const existing = await db.get('SELECT id FROM users WHERE is_master = 1');
  if (existing) return;
  await db.run(
    'INSERT INTO users (username, password_hash, is_master, permissions) VALUES (?, ?, 1, ?)',
    ['admin', hashPassword(process.env.ADMIN_PASSWORD), JSON.stringify(PERMISSIONS.map((p) => p.key))]
  );
}

app.use((req, res, next) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = token ? sessions.get(token) : null;
  req.user = session || null;
  req.isAdmin = !!(session && (session.is_master || session.permissions.size > 0));
  req.can = (key) => !!(session && (session.is_master || session.permissions.has(key)));
  res.locals.isAdmin = req.isAdmin;
  res.locals.isMaster = !!(session && session.is_master);
  res.locals.currentUser = session;
  res.locals.can = req.can;
  res.locals.fmtNum = fmtNum;
  res.locals.fmtConsumption = fmtConsumption;
  res.locals.fmtDateOnly = fmtDateOnly;
  next();
});

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!req.can(key)) return res.status(403).send('You do not have permission to access this page.');
    next();
  };
}

function requireMaster(req, res, next) {
  if (!req.user) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.is_master) return res.status(403).send('Master admin only.');
  next();
}

app.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null, next: req.query.next || '/transactions' });
});

app.post('/admin/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const next = req.body.next || '/transactions';
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(400).render('admin_login', { error: 'Incorrect username or password.', next });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    id: user.id,
    username: user.username,
    is_master: !!user.is_master,
    permissions: parsePermissions(user.permissions),
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_MAX_AGE_MS,
  });
  const openCount = (await db.get("SELECT COUNT(*) c FROM tickets WHERE status = 'OPEN'")).c;
  res.cookie('admin_login_popup', String(openCount), { sameSite: 'lax', maxAge: 30 * 1000 });
  res.redirect(next);
});

app.post('/admin/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/');
});

// ---------- user management (master admin only) ----------

app.get('/admin/users', requireMaster, async (req, res) => {
  const users = await db.all('SELECT id, username, is_master, permissions, created_at FROM users ORDER BY is_master DESC, username ASC');
  res.render('user_management', {
    users: users.map((u) => ({ ...u, permissions: parsePermissions(u.permissions) })),
    permissionList: PERMISSIONS,
    error: null,
  });
});

app.post('/admin/users/new', requireMaster, async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const permissions = PERMISSIONS.map((p) => p.key).filter((k) => req.body[`perm_${k}`] === 'on');
  if (!username || !password) {
    const users = await db.all('SELECT id, username, is_master, permissions, created_at FROM users ORDER BY is_master DESC, username ASC');
    return res.status(400).render('user_management', {
      users: users.map((u) => ({ ...u, permissions: parsePermissions(u.permissions) })),
      permissionList: PERMISSIONS,
      error: 'Username and password are required.',
    });
  }
  try {
    await db.run(
      'INSERT INTO users (username, password_hash, is_master, permissions) VALUES (?, ?, 0, ?)',
      [username, hashPassword(password), JSON.stringify(permissions)]
    );
  } catch {
    const users = await db.all('SELECT id, username, is_master, permissions, created_at FROM users ORDER BY is_master DESC, username ASC');
    return res.status(400).render('user_management', {
      users: users.map((u) => ({ ...u, permissions: parsePermissions(u.permissions) })),
      permissionList: PERMISSIONS,
      error: 'That username is already taken.',
    });
  }
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/permissions', requireMaster, async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user || user.is_master) return res.redirect('/admin/users');
  const permissions = PERMISSIONS.map((p) => p.key).filter((k) => req.body[`perm_${k}`] === 'on');
  await db.run('UPDATE users SET permissions = ? WHERE id = ?', [JSON.stringify(permissions), user.id]);
  for (const session of sessions.values()) {
    if (session.id === user.id) session.permissions = new Set(permissions);
  }
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/reset-password', requireMaster, async (req, res) => {
  const password = req.body.password || '';
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user || !password) return res.redirect('/admin/users');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user.id]);
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/delete', requireMaster, async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user || user.is_master) return res.redirect('/admin/users');
  await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  for (const [token, session] of sessions) {
    if (session.id === user.id) sessions.delete(token);
  }
  res.redirect('/admin/users');
});

// ---------- helpers ----------

function todayStr() {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

// Day used for new issue_entries records. Cuts over at 07:00 Thai time (UTC+7) instead of
// midnight, to match the factory MES's day boundary (UTC midnight). Since Thai time has no DST,
// that boundary is just the plain UTC calendar date of "now" - no offset math needed.
function entryDayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Latest known current_stock per material, as of (and including) the given date.
async function getStockAsOfMap(dateStr) {
  const rows = await db.all(
    `SELECT material_id, current_stock FROM (
       SELECT material_id, current_stock,
              ROW_NUMBER() OVER (PARTITION BY material_id ORDER BY entry_date DESC, id DESC) AS rn
       FROM issue_entries
       WHERE voided = 0 AND current_stock IS NOT NULL AND entry_date <= ?
     ) x WHERE x.rn = 1`,
    [dateStr]
  );
  const map = {};
  for (const row of rows) map[row.material_id] = row.current_stock;
  return map;
}

// Sum of issue_qty per material within [fromDate, toDate] inclusive.
async function getIssueSumMap(fromDate, toDate) {
  const rows = await db.all(
    `SELECT material_id, COALESCE(SUM(issue_qty), 0) AS total
     FROM issue_entries
     WHERE voided = 0 AND issue_qty IS NOT NULL AND entry_date BETWEEN ? AND ?
     GROUP BY material_id`,
    [fromDate, toDate]
  );
  const map = {};
  for (const row of rows) map[row.material_id] = row.total;
  return map;
}

// Sum of issue_ncn and return_ncn per material within [fromDate, toDate] inclusive.
async function getNcnSumMap(fromDate, toDate) {
  const rows = await db.all(
    `SELECT material_id,
            COALESCE(SUM(issue_ncn), 0) AS issue_ncn_total,
            COALESCE(SUM(return_ncn), 0) AS return_ncn_total
     FROM issue_entries
     WHERE voided = 0 AND entry_date BETWEEN ? AND ?
     GROUP BY material_id`,
    [fromDate, toDate]
  );
  const map = {};
  for (const row of rows) {
    map[row.material_id] = { issueNcn: row.issue_ncn_total, returnNcn: row.return_ncn_total };
  }
  return map;
}

function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function prevMonthRange(dateStr) {
  const { start } = monthRange(dateStr);
  return monthRange(addDays(start, -1));
}

function dateKey(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function buildDateRange(fromDate, toDate) {
  const dates = [];
  let cur = fromDate;
  while (cur <= toDate) {
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

// Builds an "AND <column> IN (...)" fragment for an optional list of material ids.
// materialIds === null means "no filter"; an empty array means "match nothing".
function materialIdsFilter(column, materialIds) {
  if (!materialIds) return { sql: '', params: [] };
  if (!materialIds.length) return { sql: ' AND 1=0', params: [] };
  return { sql: ` AND ${column} IN (${materialIds.map(() => '?').join(',')})`, params: materialIds };
}

// Per-day totals of issue_qty and derived usage (prevStock + issue - stock - issueNcn + returnNcn),
// summed across materials matching the workshop/shift/material filters, for every day in [fromDate, toDate].
async function getDailyIssueUsage(fromDate, toDate, workshop, shift, materialIds) {
  let filterSql = '';
  const filterParams = [];
  if (workshop) {
    filterSql += ' AND m.workshop = ?';
    filterParams.push(workshop);
  }
  if (shift) {
    filterSql += ' AND e.shift = ?';
    filterParams.push(shift);
  }
  const materialFilter = materialIdsFilter('e.material_id', materialIds);
  filterSql += materialFilter.sql;
  filterParams.push(...materialFilter.params);

  const issueRows = await db.all(
    `SELECT e.entry_date, COALESCE(SUM(e.issue_qty), 0) AS total
     FROM issue_entries e JOIN materials m ON m.id = e.material_id
     WHERE e.voided = 0 AND e.issue_qty IS NOT NULL AND e.entry_date BETWEEN ? AND ?${filterSql}
     GROUP BY e.entry_date`,
    [fromDate, toDate, ...filterParams]
  );

  const usageRows = await db.all(
    `WITH filtered AS (
       SELECT e.id, e.material_id, e.entry_date, e.issue_qty, e.current_stock, e.issue_ncn, e.return_ncn
       FROM issue_entries e JOIN materials m ON m.id = e.material_id
       WHERE e.voided = 0${filterSql}
     ),
     day_last AS (
       SELECT material_id, entry_date, current_stock,
              ROW_NUMBER() OVER (PARTITION BY material_id, entry_date ORDER BY id DESC) AS rn
       FROM filtered WHERE current_stock IS NOT NULL
     ),
     day_stock AS (
       SELECT material_id, entry_date, current_stock FROM day_last WHERE rn = 1
     ),
     day_issue AS (
       SELECT material_id, entry_date, SUM(issue_qty) AS issue_sum
       FROM filtered WHERE issue_qty IS NOT NULL GROUP BY material_id, entry_date
     ),
     day_ncn AS (
       SELECT material_id, entry_date, SUM(issue_ncn) AS issue_ncn_sum, SUM(return_ncn) AS return_ncn_sum
       FROM filtered GROUP BY material_id, entry_date
     ),
     with_prev AS (
       SELECT material_id, entry_date, current_stock,
              LAG(current_stock) OVER (PARTITION BY material_id ORDER BY entry_date) AS prev_stock
       FROM day_stock
     )
     SELECT s.entry_date,
            SUM(COALESCE(s.prev_stock, s.current_stock) + COALESCE(i.issue_sum, 0) - s.current_stock
                - COALESCE(n.issue_ncn_sum, 0) + COALESCE(n.return_ncn_sum, 0)) AS total
     FROM with_prev s
     LEFT JOIN day_issue i ON i.material_id = s.material_id AND i.entry_date = s.entry_date
     LEFT JOIN day_ncn n ON n.material_id = s.material_id AND n.entry_date = s.entry_date
     WHERE s.entry_date BETWEEN ? AND ?
     GROUP BY s.entry_date`,
    [...filterParams, fromDate, toDate]
  );

  const issueMap = {};
  issueRows.forEach((r) => { issueMap[dateKey(r.entry_date)] = r.total; });
  const usageMap = {};
  usageRows.forEach((r) => { usageMap[dateKey(r.entry_date)] = r.total; });

  return buildDateRange(fromDate, toDate).map((d) => ({
    date: d,
    issue: issueMap[d] || 0,
    usage: usageMap[d] || 0,
  }));
}

// Per-day, per-material issue and derived usage, for every material matching the
// workshop/shift/material filters that has activity in [fromDate, toDate].
async function getDailyMaterialSeries(fromDate, toDate, workshop, shift, materialIds) {
  let filterSql = '';
  const filterParams = [];
  if (workshop) {
    filterSql += ' AND m.workshop = ?';
    filterParams.push(workshop);
  }
  if (shift) {
    filterSql += ' AND e.shift = ?';
    filterParams.push(shift);
  }
  const materialFilter = materialIdsFilter('e.material_id', materialIds);
  filterSql += materialFilter.sql;
  filterParams.push(...materialFilter.params);

  const issueRows = await db.all(
    `SELECT e.material_id, e.entry_date, COALESCE(SUM(e.issue_qty), 0) AS total
     FROM issue_entries e JOIN materials m ON m.id = e.material_id
     WHERE e.voided = 0 AND e.issue_qty IS NOT NULL AND e.entry_date BETWEEN ? AND ?${filterSql}
     GROUP BY e.material_id, e.entry_date`,
    [fromDate, toDate, ...filterParams]
  );

  const usageRows = await db.all(
    `WITH filtered AS (
       SELECT e.id, e.material_id, e.entry_date, e.issue_qty, e.current_stock, e.issue_ncn, e.return_ncn
       FROM issue_entries e JOIN materials m ON m.id = e.material_id
       WHERE e.voided = 0${filterSql}
     ),
     day_last AS (
       SELECT material_id, entry_date, current_stock,
              ROW_NUMBER() OVER (PARTITION BY material_id, entry_date ORDER BY id DESC) AS rn
       FROM filtered WHERE current_stock IS NOT NULL
     ),
     day_stock AS (
       SELECT material_id, entry_date, current_stock FROM day_last WHERE rn = 1
     ),
     day_issue AS (
       SELECT material_id, entry_date, SUM(issue_qty) AS issue_sum
       FROM filtered WHERE issue_qty IS NOT NULL GROUP BY material_id, entry_date
     ),
     day_ncn AS (
       SELECT material_id, entry_date, SUM(issue_ncn) AS issue_ncn_sum, SUM(return_ncn) AS return_ncn_sum
       FROM filtered GROUP BY material_id, entry_date
     ),
     with_prev AS (
       SELECT material_id, entry_date, current_stock,
              LAG(current_stock) OVER (PARTITION BY material_id ORDER BY entry_date) AS prev_stock
       FROM day_stock
     )
     SELECT s.material_id, s.entry_date,
            COALESCE(s.prev_stock, s.current_stock) + COALESCE(i.issue_sum, 0) - s.current_stock
                - COALESCE(n.issue_ncn_sum, 0) + COALESCE(n.return_ncn_sum, 0) AS total
     FROM with_prev s
     LEFT JOIN day_issue i ON i.material_id = s.material_id AND i.entry_date = s.entry_date
     LEFT JOIN day_ncn n ON n.material_id = s.material_id AND n.entry_date = s.entry_date
     WHERE s.entry_date BETWEEN ? AND ?`,
    [...filterParams, fromDate, toDate]
  );

  const presenceRows = await db.all(
    `SELECT DISTINCT e.material_id, e.entry_date
     FROM issue_entries e JOIN materials m ON m.id = e.material_id
     WHERE e.voided = 0 AND e.entry_date BETWEEN ? AND ?${filterSql}`,
    [fromDate, toDate, ...filterParams]
  );

  const dates = buildDateRange(fromDate, toDate);
  const issueByMaterial = {};
  const usageByMaterial = {};
  const entryDatesByMaterial = {};
  const materialIdsSeen = new Set();

  issueRows.forEach((r) => {
    materialIdsSeen.add(r.material_id);
    (issueByMaterial[r.material_id] = issueByMaterial[r.material_id] || {})[dateKey(r.entry_date)] = r.total;
  });
  usageRows.forEach((r) => {
    materialIdsSeen.add(r.material_id);
    (usageByMaterial[r.material_id] = usageByMaterial[r.material_id] || {})[dateKey(r.entry_date)] = r.total;
  });
  presenceRows.forEach((r) => {
    materialIdsSeen.add(r.material_id);
    (entryDatesByMaterial[r.material_id] = entryDatesByMaterial[r.material_id] || new Set()).add(dateKey(r.entry_date));
  });

  return { dates, materialIds: [...materialIdsSeen], issueByMaterial, usageByMaterial, entryDatesByMaterial };
}

function sumDaily(daily) {
  return daily.reduce(
    (acc, d) => ({ issue: acc.issue + d.issue, usage: acc.usage + d.usage }),
    { issue: 0, usage: 0 }
  );
}

// ---------- usage anomaly detection ----------
// Flags (material, date) usage that deviates sharply from that material's own recent
// history, using a trailing median + MAD (robust to the zero/spike-heavy usage pattern
// typical of manufacturing consumption, unlike a plain mean/stdev z-score).
const ANOMALY_BASELINE_DAYS = 14;
const ANOMALY_MIN_SAMPLES = 5;
const ANOMALY_Z_THRESHOLD = 3.5;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Compares todayUsage against baselineUsages (the material's own prior 14 days).
// Returns null when there isn't enough history to judge, or when usage is within
// the normal range; otherwise returns the deviation details for display.
function detectAnomaly(baselineUsages, todayUsage) {
  if (baselineUsages.length < ANOMALY_MIN_SAMPLES) return null;
  const med = median(baselineUsages);
  const mad = median(baselineUsages.map((u) => Math.abs(u - med)));

  if (mad === 0) {
    // Baseline never moved, so a z-score is undefined; fall back to an absolute-diff
    // check with a small noise floor so trivial swings around zero aren't flagged.
    const diff = Math.abs(todayUsage - med);
    const noiseFloor = Math.max(med * 0.5, 1);
    if (diff <= noiseFloor) return null;
    return { baseline: med, z: null, deviationPct: med !== 0 ? (diff / med) * 100 : null, severity: 'moderate' };
  }

  const z = (0.6745 * (todayUsage - med)) / mad;
  if (Math.abs(z) <= ANOMALY_Z_THRESHOLD) return null;
  return {
    baseline: med,
    z,
    deviationPct: med !== 0 ? ((todayUsage - med) / med) * 100 : null,
    severity: Math.abs(z) > 5 ? 'severe' : 'moderate',
  };
}

// Computes anomalies for every (material, date) in [from, to], comparing each day's usage
// against a 14-day baseline drawn from *before* that date, so the baseline isn't
// truncated by whatever date range the dashboard filter happens to select.
async function computeUsageAnomalies(from, to, workshop, shift, materialIds, materials) {
  const seriesFrom = addDays(from, -ANOMALY_BASELINE_DAYS);
  const series = await getDailyMaterialSeries(seriesFrom, to, workshop, shift, materialIds);
  const materialMap = {};
  materials.forEach((m) => { materialMap[m.id] = m; });

  const rangeDates = buildDateRange(from, to);
  const anomalies = [];
  const currentDay = entryDayStr();

  series.materialIds.forEach((id) => {
    const material = materialMap[id];
    if (!material) return;
    const usageByDate = series.usageByMaterial[id] || {};
    const entryDates = series.entryDatesByMaterial[id] || new Set();

    rangeDates.forEach((date) => {
      const todayUsage = usageByDate[date] || 0;
      const windowDates = buildDateRange(addDays(date, -ANOMALY_BASELINE_DAYS), addDays(date, -1));
      const baselineUsages = windowDates.filter((d) => d in usageByDate).map((d) => usageByDate[d]);
      const noEntry = !entryDates.has(date);
      // The current (still in-progress) day just may not have been logged yet - don't
      // flag it as a missing entry until it's actually over.
      if (noEntry && date >= currentDay) return;
      const result = detectAnomaly(baselineUsages, todayUsage);
      // A missing entry_date row reads as usage 0 the same as a logged zero, but it means
      // no one recorded data that day rather than the material genuinely seeing no usage.
      if (result) anomalies.push({ material, date, usage: todayUsage, noEntry, ...result });
    });
  });

  return anomalies.sort((a, b) => {
    const av = a.z === null ? Infinity : Math.abs(a.z);
    const bv = b.z === null ? Infinity : Math.abs(b.z);
    return bv - av;
  });
}

// SQL Server's SYSDATETIME() returns the DB server's local (Thai, UTC+7) wall-clock time,
// but datetime2 has no offset, so the driver tags those raw digits as UTC. Shift back by the
// fixed +7 offset (using UTC getters, independent of the Node process's own timezone) to display
// the true GMT time, e.g. Thai 11:00 AM stored as "11:00" renders here as "04:00".
const THAI_UTC_OFFSET_HOURS = 7;

function fmtDate(date) {
  if (!date) return '';
  const utcDate = new Date(date.getTime() - THAI_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())} ${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`;
}

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

// Rounds to 3 significant figures, except when the 3rd significant digit is 0 - then it's
// dropped and only 2 significant figures are shown (0.000420 -> "0.00042", not "0.000420").
// Meant for small consumption ratios where a fixed decimal count would either hide the
// value entirely (0.00) or bury it in trailing zeros.
function fmtConsumption(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '-';
  const num = Number(n);
  if (num === 0) return '0';
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  let exp = Math.floor(Math.log10(abs));
  const roundToSig = (sig) => {
    const factor = Math.pow(10, sig - 1 - exp);
    return Math.round(abs * factor) / factor;
  };

  let rounded = roundToSig(3);
  const newExp = Math.floor(Math.log10(rounded));
  if (newExp !== exp) {
    exp = newExp;
    rounded = roundToSig(3);
  }

  let decimals = Math.max(0, 2 - exp);
  let str = rounded.toFixed(decimals);
  const digits = str.replace('.', '').replace(/^0+/, '') || '0';
  if (digits.length >= 3 && digits[2] === '0') {
    decimals = Math.max(0, 1 - exp);
    rounded = roundToSig(2);
    str = rounded.toFixed(decimals);
  }
  return sign + str;
}

function fmtDateOnly(date) {
  if (!date) return '';
  if (typeof date === 'string') return date.slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const EMPLOYEE_ID_RE = /^(\d{7}|admin)$/i;
const SHIFTS = ['A', 'B', 'C'];

// ---------- dashboard ----------

// Resolves the dashboard's filter set (workshop/shift/date range/material search) from a query,
// shared by the dashboard page and its CSV exports so both stay in sync.
async function resolveDashboardFilters(query) {
  const materials = await db.all('SELECT * FROM materials');
  const today = todayStr();
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);
  const thisMonth = monthRange(today);
  const workshop = workshops.includes(query.workshop) ? query.workshop : '';
  const shift = SHIFTS.includes(query.shift) ? query.shift : '';
  const from = DATE_RE.test(query.from) ? query.from : thisMonth.start;
  const to = DATE_RE.test(query.to) ? query.to : today;

  const materialIdParam = query.material_id || '';
  const selectedMaterialId = materials.some((m) => String(m.id) === materialIdParam) ? materialIdParam : '';
  const q = (query.q || '').trim();
  const materialOptions = workshop ? materials.filter((m) => m.workshop === workshop) : materials;

  let filteredMaterials = materials;
  if (selectedMaterialId) {
    filteredMaterials = filteredMaterials.filter((m) => String(m.id) === selectedMaterialId);
  }
  if (q) {
    const qLower = q.toLowerCase();
    filteredMaterials = filteredMaterials.filter(
      (m) =>
        (m.name || '').toLowerCase().includes(qLower) ||
        (m.prod_material_code || '').toLowerCase().includes(qLower) ||
        (m.material_code || '').toLowerCase().includes(qLower)
    );
  }
  // null = no material filter applied; otherwise the (possibly empty) list of matching ids.
  const materialIds = selectedMaterialId || q ? filteredMaterials.map((m) => m.id) : null;

  return {
    materials, workshops, today, thisMonth, workshop, shift, from, to,
    selectedMaterialId, q, materialOptions, filteredMaterials, materialIds,
  };
}

// Usage cost (qty consumed x unit cost) per material for the selected date range, sorted high to low.
async function computeCostRows(candidateMaterials, workshop, from, to) {
  const costMaterials = workshop ? candidateMaterials.filter((m) => m.workshop === workshop) : candidateMaterials;
  const stockToMap = await getStockAsOfMap(to);
  const stockPrevMap = await getStockAsOfMap(addDays(from, -1));
  const issueSumRangeMap = await getIssueSumMap(from, to);
  const ncnSumRangeMap = await getNcnSumMap(from, to);
  return costMaterials
    .map((m) => {
      const stock = stockToMap[m.id] || 0;
      const issue = issueSumRangeMap[m.id] || 0;
      const ncn = ncnSumRangeMap[m.id] || { issueNcn: 0, returnNcn: 0 };
      const usage = (stockPrevMap[m.id] || 0) + issue - stock - ncn.issueNcn + ncn.returnNcn;
      const cost = m.cost || 0;
      return { material: m, usage, cost, value: usage * cost };
    })
    .sort((a, b) => b.value - a.value);
}

app.get('/', async (req, res) => {
  const {
    materials, workshops, today, thisMonth, workshop, shift, from, to,
    selectedMaterialId, q, materialOptions, filteredMaterials, materialIds,
  } = await resolveDashboardFilters(req.query);

  // ---- Cost overview: usage cost (qty consumed x unit cost) for the selected date range ----
  const costRows = await computeCostRows(filteredMaterials, workshop, from, to);

  const todayFilter = materialIdsFilter('material_id', materialIds);
  const transactionsToday = (
    await db.get(
      `SELECT COUNT(*) AS c FROM issue_entries WHERE entry_date = ? AND voided = 0${todayFilter.sql}`,
      [today, ...todayFilter.params]
    )
  ).c;

  const recentFilter = materialIdsFilter('e.material_id', materialIds);
  const recentTransactions = await db.all(
    `SELECT TOP 10 e.*, m.prod_material_code, m.name AS material_name, m.unit AS material_unit
     FROM issue_entries e
     JOIN materials m ON m.id = e.material_id
     WHERE 1=1${recentFilter.sql}
     ORDER BY e.created_at DESC, e.id DESC`,
    recentFilter.params
  );

  const materialSeries = await getDailyMaterialSeries(from, to, workshop, shift, materialIds);
  const materialLabelMap = {};
  materials.forEach((m) => { materialLabelMap[m.id] = `${m.prod_material_code} - ${m.name}`; });
  const dailyChartData = {
    dates: materialSeries.dates,
    materials: materialSeries.materialIds.map((id) => ({
      id,
      label: materialLabelMap[id] || `#${id}`,
      issue: materialSeries.dates.map((d) => (materialSeries.issueByMaterial[id] || {})[d] || 0),
      usage: materialSeries.dates.map((d) => (materialSeries.usageByMaterial[id] || {})[d] || 0),
    })),
  };

  const curMonthTotals = sumDaily(await getDailyIssueUsage(thisMonth.start, thisMonth.end, workshop, shift, materialIds));
  const prevMonth = prevMonthRange(today);
  const prevMonthTotals = sumDaily(await getDailyIssueUsage(prevMonth.start, prevMonth.end, workshop, shift, materialIds));

  const usageAnomalies = req.can('dashboard_anomalies') ? (
    await computeUsageAnomalies(from, to, workshop, shift, materialIds, materials)
  ).slice(0, 5) : [];

  res.render('dashboard', {
    totalMaterials: materials.length,
    transactionsToday,
    recentTransactions,
    costRows,
    fmtDate,
    materials: materialOptions,
    workshops,
    shifts: SHIFTS,
    filters: { workshop, shift, from, to, material_id: selectedMaterialId, q },
    dailyChartData,
    curMonthTotals,
    prevMonthTotals,
    usageAnomalies,
    isAdmin: req.isAdmin,
  });
});

// ---------- materials ----------

const MATERIAL_SORT_COLUMNS = {
  code: 'prod_material_code',
  erp_code: 'material_code',
  name: 'name',
  unit: 'unit',
  workshop: 'workshop',
  stock: 'stock',
  usage: 'usage',
  issue: 'issue',
  hold: 'hold',
  cost: 'unitCost',
  usage_cost: 'usageCost',
  std_consumption: 'stdConsumption',
};

// Shared by the materials list page and its CSV export so both stay in sync.
async function getMaterialsListRows({ workshop, q, from, to }) {
  let sql = 'SELECT * FROM materials WHERE 1=1';
  const params = [];
  if (workshop) {
    sql += ' AND workshop = ?';
    params.push(workshop);
  }
  if (q) {
    sql += ' AND (name LIKE ? OR prod_material_code LIKE ? OR material_code LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const materials = await db.all(sql, params);
  const stockMap = await getStockAsOfMap(to);
  const stockYesterdayMap = await getStockAsOfMap(addDays(from, -1));
  const issueSumMap = await getIssueSumMap(from, to);
  const ncnSumMap = await getNcnSumMap(from, to);

  return materials.map((m) => {
    const stock = stockMap[m.id] || 0;
    const issue = issueSumMap[m.id] || 0;
    const ncn = ncnSumMap[m.id] || { issueNcn: 0, returnNcn: 0 };
    const usage = (stockYesterdayMap[m.id] || 0) + issue - stock - ncn.issueNcn + ncn.returnNcn;
    const hold = ncn.issueNcn - ncn.returnNcn;
    const unitCost = m.cost || 0;
    const usageCost = usage * unitCost;
    const stdConsumption = m.std_consumption || 0;
    return { material: m, stock, usage, issue, hold, unitCost, usageCost, stdConsumption };
  });
}

app.get('/materials', async (req, res) => {
  const workshop = req.query.workshop || '';
  const q = req.query.q || '';
  const today = todayStr();
  const from = req.query.from || today;
  const to = req.query.to || today;
  const sort = MATERIAL_SORT_COLUMNS[req.query.sort] ? req.query.sort : 'code';
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';

  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);
  let rows = await getMaterialsListRows({ workshop, q, from, to });

  const sortCol = MATERIAL_SORT_COLUMNS[sort];
  rows.sort((a, b) => {
    let av, bv;
    if (sortCol === 'stock' || sortCol === 'usage' || sortCol === 'issue' || sortCol === 'hold' || sortCol === 'unitCost' || sortCol === 'usageCost' || sortCol === 'stdConsumption') {
      av = a[sortCol];
      bv = b[sortCol];
    } else {
      av = (a.material[sortCol] || '').toString().toLowerCase();
      bv = (b.material[sortCol] || '').toString().toLowerCase();
    }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  const returnQs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';

  res.render('materials_list', {
    rows,
    workshops,
    selectedWorkshop: workshop,
    q,
    from,
    to,
    sort,
    dir,
    returnQs,
  });
});

const MATERIAL_CODE_PREFIX = 'TA';
const MATERIAL_CODE_DIGITS = 4;
const MATERIAL_CODE_RE = new RegExp(`^${MATERIAL_CODE_PREFIX}(\\d+)$`, 'i');

async function getNextMaterialCode() {
  const rows = await db.all('SELECT prod_material_code FROM materials');
  let max = 0;
  for (const r of rows) {
    const m = MATERIAL_CODE_RE.exec(r.prod_material_code || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return MATERIAL_CODE_PREFIX + String(max + 1).padStart(MATERIAL_CODE_DIGITS, '0');
}

app.get('/materials/new', requirePermission('materials_manage'), async (req, res) => {
  res.render('material_form', {
    material: { prod_material_code: await getNextMaterialCode(), decimal_places: 3 },
    units: KNOWN_UNITS,
    workshops: KNOWN_WORKSHOPS,
    error: null,
    editingId: null,
    returnQs: req.query.return_qs || '',
  });
});

app.post('/materials/new', requirePermission('materials_manage'), async (req, res) => {
  const { material_code = '', name, unit, workshop, min_stock, decimal_places, cost, std_consumption } = req.body;
  const minStock = parseFloat(min_stock) || 0;
  const unitCost = parseFloat(cost) || 0;
  const stdConsumption = parseFloat(std_consumption) || 0;
  const parsedDecimalPlaces = parseInt(decimal_places, 10);
  const decimalPlaces = Number.isNaN(parsedDecimalPlaces) ? 3 : Math.min(6, Math.max(0, parsedDecimalPlaces));
  const returnQs = req.body.return_qs || '';

  let error = null;
  if (minStock < 0) {
    error = 'Minimum stock cannot be negative.';
  } else if (unitCost < 0) {
    error = 'Unit cost cannot be negative.';
  } else if (stdConsumption < 0) {
    error = 'STD Consumption cannot be negative.';
  }

  if (error) {
    return res.status(400).render('material_form', {
      material: { prod_material_code: await getNextMaterialCode(), material_code, name, unit, workshop, min_stock: minStock, decimal_places: decimalPlaces, cost: unitCost, std_consumption: stdConsumption },
      units: KNOWN_UNITS,
      workshops: KNOWN_WORKSHOPS,
      error,
      editingId: null,
      returnQs,
    });
  }

  // Loop to absorb the rare case where another admin grabs the same next code first.
  for (let attempt = 0; attempt < 5; attempt++) {
    const prodMaterialCode = await getNextMaterialCode();
    try {
      await db.run(
        `INSERT INTO materials (prod_material_code, material_code, name, unit, workshop, min_stock, decimal_places, cost, std_consumption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [prodMaterialCode, material_code.trim(), name.trim(), unit.trim(), workshop.trim(), minStock, decimalPlaces, unitCost, stdConsumption]
      );
      return res.redirect(returnQs ? `/materials?${returnQs}` : '/materials');
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
});

app.get('/materials/:id/edit', requirePermission('materials_manage'), async (req, res) => {
  const material = await db.get('SELECT * FROM materials WHERE id = ?', [req.params.id]);
  res.render('material_form', {
    material,
    units: KNOWN_UNITS,
    workshops: KNOWN_WORKSHOPS,
    error: null,
    editingId: req.params.id,
    returnQs: req.query.return_qs || '',
  });
});

app.post('/materials/:id/edit', requirePermission('materials_manage'), async (req, res) => {
  const materialId = req.params.id;
  const { material_code = '', name, unit, workshop, min_stock, decimal_places, cost, std_consumption } = req.body;
  const prodMaterialCode = (req.body.prod_material_code || '').trim();
  const minStock = parseFloat(min_stock) || 0;
  const unitCost = parseFloat(cost) || 0;
  const stdConsumption = parseFloat(std_consumption) || 0;
  const parsedDecimalPlaces = parseInt(decimal_places, 10);
  const decimalPlaces = Number.isNaN(parsedDecimalPlaces) ? 3 : Math.min(6, Math.max(0, parsedDecimalPlaces));
  const returnQs = req.body.return_qs || '';

  let error = null;
  if (!prodMaterialCode) {
    error = 'Material code is required.';
  } else {
    const conflict = await db.get(
      'SELECT 1 AS x FROM materials WHERE LOWER(prod_material_code) = LOWER(?) AND id != ?',
      [prodMaterialCode, materialId]
    );
    if (conflict) error = `Material code '${prodMaterialCode}' already exists.`;
  }
  if (minStock < 0) error = 'Minimum stock cannot be negative.';
  else if (unitCost < 0) error = 'Unit cost cannot be negative.';
  else if (stdConsumption < 0) error = 'STD Consumption cannot be negative.';

  if (error) {
    return res.status(400).render('material_form', {
      material: {
        id: materialId,
        prod_material_code: prodMaterialCode,
        material_code,
        name,
        unit,
        workshop,
        min_stock: minStock,
        decimal_places: decimalPlaces,
        cost: unitCost,
        std_consumption: stdConsumption,
      },
      units: KNOWN_UNITS,
      workshops: KNOWN_WORKSHOPS,
      error,
      editingId: materialId,
      returnQs,
    });
  }

  await db.run(
    `UPDATE materials SET prod_material_code = ?, material_code = ?, name = ?, unit = ?, workshop = ?, min_stock = ?, decimal_places = ?, cost = ?, std_consumption = ?
     WHERE id = ?`,
    [prodMaterialCode, material_code.trim(), name.trim(), unit.trim(), workshop.trim(), minStock, decimalPlaces, unitCost, stdConsumption, materialId]
  );

  res.redirect(returnQs ? `/materials?${returnQs}` : '/materials');
});

const INLINE_EDITABLE_FIELDS = new Set(['cost', 'std_consumption']);

app.post('/materials/:id/inline-update', async (req, res) => {
  if (!req.can('materials_manage')) return res.status(403).json({ error: 'Admin only.' });
  const { field, value } = req.body;
  if (!INLINE_EDITABLE_FIELDS.has(field)) return res.status(400).json({ error: 'Invalid field.' });
  const num = parseFloat(value);
  if (isNaN(num) || num < 0) return res.status(400).json({ error: 'Value must be a non-negative number.' });

  const material = await db.get('SELECT id FROM materials WHERE id = ?', [req.params.id]);
  if (!material) return res.status(404).json({ error: 'Material not found.' });

  await db.run(`UPDATE materials SET ${field} = ? WHERE id = ?`, [num, req.params.id]);
  res.json({ ok: true, value: num });
});

app.post('/materials/:id/delete', requirePermission('materials_manage'), async (req, res) => {
  await db.run('DELETE FROM issue_entries WHERE material_id = ?', [req.params.id]);
  await db.run('DELETE FROM materials WHERE id = ?', [req.params.id]);
  const qs = req.body.return_qs || '';
  res.redirect(qs ? `/materials?${qs}` : '/materials');
});

// ---------- issue (bulk daily entry) ----------

const NUMERIC_FIELDS = ['current_stock', 'issue_qty', 'issue_ncn', 'return_ncn'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getIssueMaterials(workshop) {
  if (workshop) {
    return db.all('SELECT * FROM materials WHERE workshop = ? ORDER BY prod_material_code', [workshop]);
  }
  return db.all('SELECT * FROM materials ORDER BY prod_material_code');
}

async function renderIssueForm(req, res, status, extra) {
  const workshop = extra.workshop || '';
  const entryDate = extra.entryDate || entryDayStr();
  const materials = await getIssueMaterials(workshop);
  // Matches the carry-forward default applied in POST /issue when Current Stock is left blank.
  const stockMap = await getStockAsOfMap(addDays(entryDate, -1));
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);
  res.status(status).render('issue', {
    materials,
    stockMap,
    shifts: SHIFTS,
    workshops,
    selectedWorkshop: workshop,
    entryDate,
    today: entryDayStr(),
    isAdmin: req.isAdmin,
    error: null,
    success: null,
    negativeUsage: null,
    values: {},
    employeeId: '',
    shift: '',
    ...extra,
  });
}

app.get('/issue', async (req, res) => {
  const entryDate = req.can('issue_backdate') && DATE_RE.test(req.query.date) ? req.query.date : entryDayStr();
  await renderIssueForm(req, res, 200, { success: req.query.success, workshop: req.query.workshop || '', entryDate });
});

app.post('/issue', async (req, res) => {
  const workshop = req.body.workshop || '';
  const materials = await getIssueMaterials(workshop);
  const employeeId = (req.body.employee_id || '').trim();
  const shift = req.body.shift || '';
  const entryDate = req.can('issue_backdate') && DATE_RE.test(req.body.entry_date) ? req.body.entry_date : entryDayStr();

  let error = null;
  if (!EMPLOYEE_ID_RE.test(employeeId)) {
    error = 'Employee ID must be exactly 7 digits.';
  } else if (!SHIFTS.includes(shift)) {
    error = 'Please select a valid shift (A, B, or C).';
  }

  // Current Stock must be recorded every day, so a blank Current Stock field falls back to the
  // last known value (carried forward) instead of being skipped.
  const stockYesterdayMap = await getStockAsOfMap(addDays(entryDate, -1));

  const values = {};
  const rowsToInsert = [];
  for (const m of materials) {
    const raw = {};
    for (const field of NUMERIC_FIELDS) {
      raw[field] = (req.body[`${field}_${m.id}`] || '').trim();
    }
    values[m.id] = raw;

    // Material wasn't touched at all this submission — skip it entirely so it
    // doesn't count as "recorded today" and remains available to key in later.
    if (NUMERIC_FIELDS.every((field) => raw[field] === '')) continue;

    const parsed = {};
    let rowError = false;
    for (const field of NUMERIC_FIELDS) {
      if (raw[field] === '') {
        parsed[field] = null;
        continue;
      }
      const num = parseFloat(raw[field]);
      if (Number.isNaN(num)) {
        error = error || 'Entered values must be numbers.';
        rowError = true;
        break;
      }
      if (num < 0) {
        error = error || 'Entered values cannot be negative.';
        rowError = true;
        break;
      }
      parsed[field] = num;
    }
    if (rowError) continue;
    if (parsed.current_stock == null) {
      parsed.current_stock = stockYesterdayMap[m.id] != null ? stockYesterdayMap[m.id] : 0;
    }
    rowsToInsert.push({ materialId: m.id, ...parsed });
  }

  if (!rowsToInsert.length && !error) {
    error = 'Enter at least one value.';
  }

  // Block accidental double-entry of the same material on the same day. Admins are exempt
  // since they intentionally re-enter/backdate records to correct mistakes.
  if (!error && rowsToInsert.length && !req.can('issue_backdate')) {
    const rowMaterialIds = rowsToInsert.map((r) => r.materialId);
    const dupFilter = materialIdsFilter('material_id', rowMaterialIds);
    const dupRows = await db.all(
      `SELECT DISTINCT material_id FROM issue_entries WHERE entry_date = ? AND voided = 0${dupFilter.sql}`,
      [entryDate, ...dupFilter.params]
    );
    if (dupRows.length) {
      const dupIds = new Set(dupRows.map((r) => r.material_id));
      const dupCodes = materials.filter((m) => dupIds.has(m.id)).map((m) => m.prod_material_code);
      error = `Already recorded today for: ${dupCodes.join(', ')}. Duplicate entries for the same day are not allowed.`;
    }
  }

  if (error) {
    return renderIssueForm(req, res, 400, { error, values, employeeId, shift, workshop, entryDate });
  }

  // Block any submission where a material's usage would come out negative. Computed against
  // pre-insert data plus this submission's own values, since the row hasn't been written yet.
  const stockTodayMapBefore = await getStockAsOfMap(entryDate);
  const issueSumMapBefore = await getIssueSumMap(entryDate, entryDate);
  const ncnSumMapBefore = await getNcnSumMap(entryDate, entryDate);
  const negativeUsage = [];
  for (const row of rowsToInsert) {
    const projectedIssueSum = (issueSumMapBefore[row.materialId] || 0) + (row.issue_qty || 0);
    const projectedStockToday = row.current_stock != null ? row.current_stock : (stockTodayMapBefore[row.materialId] || 0);
    const ncnBefore = ncnSumMapBefore[row.materialId] || { issueNcn: 0, returnNcn: 0 };
    const projectedIssueNcn = ncnBefore.issueNcn + (row.issue_ncn || 0);
    const projectedReturnNcn = ncnBefore.returnNcn + (row.return_ncn || 0);
    const usage = (stockYesterdayMap[row.materialId] || 0) + projectedIssueSum - projectedStockToday
      - projectedIssueNcn + projectedReturnNcn;
    if (usage < 0) {
      const material = materials.find((m) => m.id === row.materialId);
      negativeUsage.push({ code: material.prod_material_code, name: material.name, usage });
    }
  }

  if (negativeUsage.length) {
    return renderIssueForm(req, res, 400, {
      values, employeeId, shift, workshop, entryDate, negativeUsage,
    });
  }

  for (const row of rowsToInsert) {
    await db.run(
      `INSERT INTO issue_entries (material_id, entry_date, current_stock, issue_qty, issue_ncn, return_ncn, employee_id, shift)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.materialId, entryDate, row.current_stock, row.issue_qty, row.issue_ncn, row.return_ncn, employeeId, shift]
    );
  }

  await renderIssueForm(req, res, 200, { success: true, workshop, entryDate });
});

// ---------- consumption calculator ----------

// QuantityMoved in DashboardWipProcessDaily is raw Pcs; divide by 1000 to match the
// kPcs unit the Product Output field is expressed in.
const MES_OUTPUT_UNIT_DIVISOR = 1000;

// Per-day QuantityMoved (in kPcs) for the given operation/series, keyed by date string.
async function getMesDailyOutputMap(operationName, series, fromDate, toDate) {
  const placeholders = series.map(() => '?').join(', ');
  const rows = await db.mes.all(
    `SELECT ReportingDate, SUM(QuantityMoved) AS total FROM DashboardWipProcessDaily
     WHERE OperationName = ? AND Serie IN (${placeholders}) AND ReportingDate BETWEEN ? AND ?
     GROUP BY ReportingDate`,
    [operationName, ...series, fromDate, toDate]
  );
  const map = {};
  rows.forEach((r) => { map[dateKey(r.ReportingDate)] = Number(r.total) / MES_OUTPUT_UNIT_DIVISOR; });
  return map;
}

async function computeConsumption(query) {
  const workshop = query.workshop || '';
  const materialId = query.material_id || '';
  const today = todayStr();
  const from = query.from || today;
  const to = query.to || today;
  const operationName = query.operation_name || '';
  const selectedSeries = [].concat(query.serie || []).filter(Boolean);

  const materials = await getIssueMaterials(workshop);
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);

  const operationNames = (
    await db.mes.all('SELECT DISTINCT OperationName FROM DashboardWipProcessDaily WHERE OperationName IS NOT NULL ORDER BY OperationName')
  ).map((r) => r.OperationName);

  let seriesOptions = [];
  if (operationName) {
    seriesOptions = (
      await db.mes.all(
        'SELECT DISTINCT Serie FROM DashboardWipProcessDaily WHERE OperationName = ? AND Serie IS NOT NULL ORDER BY Serie',
        [operationName]
      )
    ).map((r) => r.Serie);
  }

  let mesOutput = null;
  let mesDailyOutput = null;
  if (operationName && selectedSeries.length) {
    mesDailyOutput = await getMesDailyOutputMap(operationName, selectedSeries, from, to);
    mesOutput = Object.values(mesDailyOutput).reduce((sum, v) => sum + v, 0);
  }

  let result = null;
  let error = null;
  let dailyChartData = null;
  if (materialId) {
    const material = await db.get('SELECT * FROM materials WHERE id = ?', [materialId]);
    if (!material) {
      error = 'Material not found.';
    } else {
      const stockYesterday = (await getStockAsOfMap(addDays(from, -1)))[material.id] || 0;
      const stockToday = (await getStockAsOfMap(to))[material.id] || 0;
      const issueSum = (await getIssueSumMap(from, to))[material.id] || 0;
      const ncn = (await getNcnSumMap(from, to))[material.id] || { issueNcn: 0, returnNcn: 0 };
      const usage = stockYesterday + issueSum - stockToday - ncn.issueNcn + ncn.returnNcn;

      const output = mesOutput;
      let consumption = null;
      if (output != null) {
        if (output <= 0) {
          error = 'Output must be greater than zero.';
        } else {
          consumption = usage / output;
        }
      }

      result = { material, usage, output, consumption };

      if (!error) {
        const daily = await getDailyMaterialSeries(from, to, '', '', [material.id]);
        const usageByDate = daily.usageByMaterial[material.id] || {};
        const dailyUsage = daily.dates.map((d) => usageByDate[d] || 0);
        const dailyOutput = mesDailyOutput ? daily.dates.map((d) => mesDailyOutput[d] || 0) : null;
        const dailyConsumption = dailyOutput
          ? daily.dates.map((_, i) => (dailyOutput[i] > 0 ? dailyUsage[i] / dailyOutput[i] : null))
          : null;
        dailyChartData = { dates: daily.dates, usage: dailyUsage, output: dailyOutput, consumption: dailyConsumption };
      }
    }
  }

  return {
    materials,
    workshops,
    selectedWorkshop: workshop,
    selectedMaterialId: materialId,
    from,
    to,
    operationNames,
    selectedOperationName: operationName,
    seriesOptions,
    selectedSeries,
    mesOutput,
    dailyChartData,
    result,
    error,
  };
}

app.get('/consumption', async (req, res) => {
  const data = await computeConsumption(req.query);
  res.render('consumption', data);
});

app.get('/export/consumption.csv', async (req, res) => {
  const data = await computeConsumption(req.query);

  const lines = ['Date,Workshop,Process,Material,Output,Consumption,Unit'];
  if (data.result && !data.error && data.dailyChartData) {
    const { material } = data.result;
    const { dates, output, consumption } = data.dailyChartData;
    dates.forEach((d, i) => {
      lines.push(
        [
          d,
          material.workshop,
          data.selectedOperationName,
          `${material.prod_material_code} - ${material.name}`,
          output ? output[i] : '',
          consumption && consumption[i] != null ? consumption[i] : '',
          material.unit,
        ]
          .map(csvEscape)
          .join(',')
      );
    });
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=consumption.csv');
  res.send(lines.join('\r\n'));
});

// ---------- process map (admin: material <-> MES operation/serie/part number) ----------
// Two linked views: Material<->Operation (one Operation per material), and, once an
// Operation is set, Material<->Serie (many series per material) with an optional
// Part Number subset per material-serie link.

app.get('/process-map', requirePermission('process_map'), async (req, res) => {
  const workshop = req.query.workshop || '';
  const materials = await getIssueMaterials(workshop);
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);
  const operationNames = (
    await db.mes.all('SELECT DISTINCT OperationName FROM DashboardWipProcessDaily WHERE OperationName IS NOT NULL ORDER BY OperationName')
  ).map((r) => r.OperationName);

  const mapRows = await db.all('SELECT * FROM material_process_map');
  const operationByMaterialId = {};
  mapRows.forEach((r) => { operationByMaterialId[r.material_id] = r.operation_name; });

  res.render('process_map', {
    materials,
    workshops,
    selectedWorkshop: workshop,
    operationNames,
    operationByMaterialId,
    saved: req.query.saved === '1',
  });
});

app.post('/process-map/operation', requirePermission('process_map'), async (req, res) => {
  const materialId = Number(req.body.material_id);
  const operationName = req.body.operation_name || '';
  const returnQs = req.body.return_qs || '';
  const sep = returnQs ? '&' : '?';
  const redirectTo = returnQs ? `/process-map?${returnQs}${sep}saved=1` : '/process-map?saved=1';

  const material = await db.get('SELECT id FROM materials WHERE id = ?', [materialId]);
  if (!material || !operationName) return res.redirect(redirectTo);

  const existing = await db.get('SELECT id, operation_name FROM material_process_map WHERE material_id = ?', [materialId]);
  if (existing) {
    if (existing.operation_name !== operationName) {
      // Changing the operation invalidates any series chosen under the old one.
      await db.run('DELETE FROM material_process_series WHERE material_process_map_id = ?', [existing.id]);
      await db.run('UPDATE material_process_map SET operation_name = ?, updated_at = SYSDATETIME() WHERE id = ?', [operationName, existing.id]);
    }
  } else {
    await db.run('INSERT INTO material_process_map (material_id, operation_name) VALUES (?, ?)', [materialId, operationName]);
  }
  res.redirect(redirectTo);
});

app.post('/process-map/operation/clear', requirePermission('process_map'), async (req, res) => {
  const materialId = Number(req.body.material_id);
  const returnQs = req.body.return_qs || '';
  await db.run('DELETE FROM material_process_map WHERE material_id = ?', [materialId]);
  res.redirect(returnQs ? `/process-map?${returnQs}` : '/process-map');
});

// Batch save for the Material <-> Process diagram: applies every pending set/clear picked
// in the browser in one request, so the user can select many pairs before a single reload.
app.post('/process-map/operation/batch', requirePermission('process_map'), async (req, res) => {
  let changes = [];
  try {
    changes = JSON.parse(req.body.changes || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid changes payload' });
  }

  for (const change of changes) {
    const materialId = Number(change.material_id);
    const operationName = (change.operation_name || '').trim();
    if (!materialId) continue;

    const existing = await db.get('SELECT id, operation_name FROM material_process_map WHERE material_id = ?', [materialId]);

    if (!operationName) {
      if (existing) await db.run('DELETE FROM material_process_map WHERE material_id = ?', [materialId]);
      continue;
    }

    const material = await db.get('SELECT id FROM materials WHERE id = ?', [materialId]);
    if (!material) continue;

    if (existing) {
      if (existing.operation_name !== operationName) {
        await db.run('DELETE FROM material_process_series WHERE material_process_map_id = ?', [existing.id]);
        await db.run('UPDATE material_process_map SET operation_name = ?, updated_at = SYSDATETIME() WHERE id = ?', [operationName, existing.id]);
      }
    } else {
      await db.run('INSERT INTO material_process_map (material_id, operation_name) VALUES (?, ?)', [materialId, operationName]);
    }
  }

  res.json({ ok: true });
});

// Series options for a given OperationName - used to populate the Serie choices once an
// Operation is set, without a full page reload.
app.get('/process-map/series', requirePermission('process_map'), async (req, res) => {
  const operationName = req.query.operation_name || '';
  if (!operationName) return res.json({ series: [] });
  const rows = await db.mes.all(
    'SELECT DISTINCT Serie FROM DashboardWipProcessDaily WHERE OperationName = ? AND Serie IS NOT NULL ORDER BY Serie',
    [operationName]
  );
  res.json({ series: rows.map((r) => r.Serie) });
});

// ---------- process map: material <-> serie (+ part number) view ----------

app.get('/process-map/series-view', requirePermission('process_map'), async (req, res) => {
  const workshop = req.query.workshop || '';
  const search = (req.query.q || '').trim();

  let materials = workshop ? await getIssueMaterials(workshop) : [];
  if (search) {
    const like = `%${search}%`;
    materials = (workshop ? materials : await getIssueMaterials(''))
      .filter((m) => m.prod_material_code.toLowerCase().includes(search.toLowerCase()) || m.name.toLowerCase().includes(search.toLowerCase()));
  }
  // Require at least one filter before loading materials, to keep the diagram from
  // rendering hundreds of nodes at once.
  const showDiagram = Boolean(workshop || search);

  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);

  let materialData = [];
  if (showDiagram && materials.length) {
    const materialIds = materials.map((m) => m.id);
    const placeholders = materialIds.map(() => '?').join(', ');
    const mapRows = materialIds.length
      ? await db.all(`SELECT * FROM material_process_map WHERE material_id IN (${placeholders})`, materialIds)
      : [];
    const mapByMaterialId = {};
    mapRows.forEach((r) => { mapByMaterialId[r.material_id] = r; });

    const mapIds = mapRows.map((r) => r.id);
    const seriesRows = mapIds.length
      ? await db.all(`SELECT * FROM material_process_series WHERE material_process_map_id IN (${mapIds.map(() => '?').join(', ')})`, mapIds)
      : [];
    const seriesByMapId = {};
    seriesRows.forEach((r) => {
      if (!seriesByMapId[r.material_process_map_id]) seriesByMapId[r.material_process_map_id] = [];
      seriesByMapId[r.material_process_map_id].push(r);
    });

    const seriesIds = seriesRows.map((r) => r.id);
    const pnRows = seriesIds.length
      ? await db.all(
          `SELECT * FROM material_process_series_part_numbers WHERE material_process_series_id IN (${seriesIds.map(() => '?').join(', ')})`,
          seriesIds
        )
      : [];
    const pnByseriesId = {};
    pnRows.forEach((r) => {
      if (!pnByseriesId[r.material_process_series_id]) pnByseriesId[r.material_process_series_id] = [];
      pnByseriesId[r.material_process_series_id].push(r.part_number);
    });

    materialData = materials.map((m) => {
      const mapping = mapByMaterialId[m.id];
      const series = mapping
        ? (seriesByMapId[mapping.id] || []).map((s) => ({ id: s.id, serie: s.serie, partNumbers: pnByseriesId[s.id] || [] }))
        : [];
      return { material: m, operationName: mapping ? mapping.operation_name : null, series };
    });
  }

  let allSeries = KNOWN_SERIES;

  if (workshop) {
    const serieWorkshopRows = await db.all('SELECT serie FROM serie_workshop_map WHERE workshop = ?', [workshop]);
    const allowedSeries = new Set(serieWorkshopRows.map((r) => r.serie));
    allSeries = allSeries.filter((s) => allowedSeries.has(s));
  }

  res.render('process_map_series', {
    materialData,
    workshops,
    selectedWorkshop: workshop,
    search,
    showDiagram,
    allSeries,
    saved: req.query.saved === '1',
  });
});

app.post('/process-map/series-view/toggle', requirePermission('process_map'), async (req, res) => {
  const materialId = Number(req.body.material_id);
  const serie = req.body.serie || '';
  const returnQs = req.body.return_qs || '';
  const redirectTo = returnQs ? `/process-map/series-view?${returnQs}` : '/process-map/series-view';

  const mapping = await db.get('SELECT id, operation_name FROM material_process_map WHERE material_id = ?', [materialId]);
  if (!mapping || !serie) return res.redirect(redirectTo);

  const existing = await db.get(
    'SELECT id FROM material_process_series WHERE material_process_map_id = ? AND serie = ?',
    [mapping.id, serie]
  );
  if (existing) {
    await db.run('DELETE FROM material_process_series WHERE id = ?', [existing.id]);
    return res.redirect(redirectTo);
  }

  const validSerie = await db.mes.get(
    'SELECT TOP 1 1 AS ok FROM DashboardWipProcessDaily WHERE OperationName = ? AND Serie = ?',
    [mapping.operation_name, serie]
  );
  if (!validSerie) return res.redirect(redirectTo);

  await db.run('INSERT INTO material_process_series (material_process_map_id, serie) VALUES (?, ?)', [mapping.id, serie]);
  res.redirect(redirectTo);
});

// Batch save for the Material <-> Serie diagram: applies every pending connect/disconnect
// picked in the browser in one request, so the user can select many pairs before a single reload.
app.post('/process-map/series-view/toggle/batch', requirePermission('process_map'), async (req, res) => {
  let changes = [];
  try {
    changes = JSON.parse(req.body.changes || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid changes payload' });
  }

  for (const change of changes) {
    const materialId = Number(change.material_id);
    const serie = (change.serie || '').trim();
    const action = change.action === 'remove' ? 'remove' : 'add';
    if (!materialId || !serie) continue;

    const mapping = await db.get('SELECT id, operation_name FROM material_process_map WHERE material_id = ?', [materialId]);
    if (!mapping) continue;

    const existing = await db.get(
      'SELECT id FROM material_process_series WHERE material_process_map_id = ? AND serie = ?',
      [mapping.id, serie]
    );

    if (action === 'remove') {
      if (existing) await db.run('DELETE FROM material_process_series WHERE id = ?', [existing.id]);
      continue;
    }

    if (existing) continue;

    const validSerie = await db.mes.get(
      'SELECT TOP 1 1 AS ok FROM DashboardWipProcessDaily WHERE OperationName = ? AND Serie = ?',
      [mapping.operation_name, serie]
    );
    if (!validSerie) continue;

    await db.run('INSERT INTO material_process_series (material_process_map_id, serie) VALUES (?, ?)', [mapping.id, serie]);
  }

  res.json({ ok: true });
});

// Part Numbers imported for a given serie, for the expand-to-select UI.
app.get('/process-map/part-numbers', requirePermission('process_map'), async (req, res) => {
  const serie = req.query.serie || '';
  if (!serie) return res.json({ partNumbers: [] });
  const rows = await db.all(
    'SELECT part_number FROM serie_part_numbers WHERE serie = ? ORDER BY part_number',
    [serie]
  );
  res.json({ partNumbers: rows.map((r) => r.part_number) });
});

// ---------- process map: part number matching (admin data entry) ----------

app.get('/process-map/part-numbers/list', requirePermission('process_map'), async (req, res) => {
  const series = KNOWN_SERIES;

  res.render('process_map_part_numbers', {
    series,
    saved: req.query.saved === '1',
  });
});

app.post('/process-map/part-numbers', requirePermission('process_map'), async (req, res) => {
  const serie = req.body.serie || '';
  const returnQs = req.body.return_qs || '';
  const redirectTo = returnQs ? `/process-map/part-numbers/list?${returnQs}&saved=1` : '/process-map/part-numbers/list?saved=1';

  if (!serie) return res.redirect(redirectTo);

  const partNumbers = [...new Set(
    [].concat(req.body.part_number || []).map((v) => (v || '').trim()).filter(Boolean)
  )];

  const existing = await db.all('SELECT part_number FROM serie_part_numbers WHERE serie = ?', [serie]);
  const existingSet = new Set(existing.map((r) => r.part_number));
  const newSet = new Set(partNumbers);

  const toDelete = [...existingSet].filter((pn) => !newSet.has(pn));
  const toInsert = partNumbers.filter((pn) => !existingSet.has(pn));

  for (const pn of toDelete) {
    await db.run('DELETE FROM serie_part_numbers WHERE serie = ? AND part_number = ?', [serie, pn]);
  }
  for (const pn of toInsert) {
    await db.run('INSERT INTO serie_part_numbers (serie, part_number) VALUES (?, ?)', [serie, pn]);
  }

  res.redirect(redirectTo);
});

app.post('/process-map/series-view/part-numbers', requirePermission('process_map'), async (req, res) => {
  const materialProcessSeriesId = Number(req.body.material_process_series_id);
  const partNumbers = [].concat(req.body.part_number || []).filter(Boolean);
  const returnQs = req.body.return_qs || '';
  const redirectTo = returnQs ? `/process-map/series-view?${returnQs}` : '/process-map/series-view';
  const isAjax = req.body.ajax === '1';

  const seriesRow = await db.get('SELECT id FROM material_process_series WHERE id = ?', [materialProcessSeriesId]);
  if (!seriesRow) return isAjax ? res.status(404).end() : res.redirect(redirectTo);

  await db.run('DELETE FROM material_process_series_part_numbers WHERE material_process_series_id = ?', [materialProcessSeriesId]);
  for (const pn of partNumbers) {
    await db.run(
      'INSERT INTO material_process_series_part_numbers (material_process_series_id, part_number) VALUES (?, ?)',
      [materialProcessSeriesId, pn]
    );
  }

  if (isAjax) return res.status(204).end();
  res.redirect(redirectTo);
});

// ---------- process map: serie <-> workshop mapping (used to filter the Serie tab) ----------

app.get('/process-map/serie-workshop/list', requirePermission('process_map'), async (req, res) => {
  const series = KNOWN_SERIES;

  const mapRows = await db.all('SELECT serie, workshop FROM serie_workshop_map');
  const workshopBySerie = {};
  mapRows.forEach((r) => { workshopBySerie[r.serie] = r.workshop; });

  res.render('process_map_serie_workshop', {
    series,
    workshopBySerie,
    workshops: KNOWN_WORKSHOPS,
    saved: req.query.saved === '1',
  });
});

app.post('/process-map/serie-workshop', requirePermission('process_map'), async (req, res) => {
  const seriesIn = [].concat(req.body.serie || []);
  const workshopsIn = [].concat(req.body.workshop || []);

  const existing = await db.all('SELECT serie FROM serie_workshop_map');
  const existingSet = new Set(existing.map((r) => r.serie));
  const keepSet = new Set();

  for (let i = 0; i < seriesIn.length; i++) {
    const serie = (seriesIn[i] || '').trim();
    const workshop = (workshopsIn[i] || '').trim();
    if (!serie || !workshop) continue;
    keepSet.add(serie);
    if (existingSet.has(serie)) {
      await db.run('UPDATE serie_workshop_map SET workshop = ?, updated_at = SYSDATETIME() WHERE serie = ?', [workshop, serie]);
    } else {
      await db.run('INSERT INTO serie_workshop_map (serie, workshop) VALUES (?, ?)', [serie, workshop]);
    }
  }

  for (const serie of existingSet) {
    if (!keepSet.has(serie)) await db.run('DELETE FROM serie_workshop_map WHERE serie = ?', [serie]);
  }

  res.redirect('/process-map/serie-workshop/list?saved=1');
});

// ---------- monthly consumption report ----------

const MONTH_RE = /^\d{4}-\d{2}$/;

async function computeMonthlyConsumptionReport(query) {
  const workshop = query.workshop || '';
  const today = todayStr();
  const currentMonth = today.slice(0, 7);
  const month = MONTH_RE.test(query.month) ? query.month : currentMonth;

  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);
  const materials = await getIssueMaterials(workshop);

  const { start, end: monthEnd } = monthRange(`${month}-01`);
  const end = month === currentMonth && monthEnd > today ? today : monthEnd;

  const stockPrevMap = await getStockAsOfMap(addDays(start, -1));
  const stockToMap = await getStockAsOfMap(end);
  const issueSumMap = await getIssueSumMap(start, end);
  const ncnSumMap = await getNcnSumMap(start, end);

  const mapRows = await db.all('SELECT * FROM material_process_map');
  const mapByMaterialId = {};
  mapRows.forEach((r) => { mapByMaterialId[r.material_id] = { operation_name: r.operation_name, series: [] }; });
  const mapIdToMaterialId = {};
  mapRows.forEach((r) => { mapIdToMaterialId[r.id] = r.material_id; });
  const seriesRows = mapRows.length
    ? await db.all(
        `SELECT * FROM material_process_series WHERE material_process_map_id IN (${mapRows.map(() => '?').join(', ')}) ORDER BY serie`,
        mapRows.map((r) => r.id)
      )
    : [];
  seriesRows.forEach((r) => {
    const materialId = mapIdToMaterialId[r.material_process_map_id];
    if (mapByMaterialId[materialId]) mapByMaterialId[materialId].series.push(r.serie);
  });
  // A material with an Operation but no series chosen yet has nothing to compute against.
  Object.keys(mapByMaterialId).forEach((materialId) => {
    if (!mapByMaterialId[materialId].series.length) delete mapByMaterialId[materialId];
  });

  // Group mapped materials by (operation_name, series set) so each distinct combination is
  // only queried against MES once, even if several materials share it.
  const outputByPairKey = {};
  const pairsNeeded = new Map();
  materials.forEach((m) => {
    const mapping = mapByMaterialId[m.id];
    if (!mapping) return;
    const key = mapping.operation_name + '|' + mapping.series.join(',');
    pairsNeeded.set(key, { operationName: mapping.operation_name, series: mapping.series });
  });
  for (const [key, { operationName, series }] of pairsNeeded) {
    const dailyOutput = await getMesDailyOutputMap(operationName, series, start, end);
    outputByPairKey[key] = Object.values(dailyOutput).reduce((sum, v) => sum + v, 0);
  }

  // Previous month totals (usage cost only) for the month-over-month comparison tile.
  const prevMonth = prevMonthRange(`${month}-01`);
  const prevStockPrevMap = await getStockAsOfMap(addDays(prevMonth.start, -1));
  const prevStockToMap = await getStockAsOfMap(prevMonth.end);
  const prevIssueSumMap = await getIssueSumMap(prevMonth.start, prevMonth.end);
  const prevNcnSumMap = await getNcnSumMap(prevMonth.start, prevMonth.end);

  let prevMonthCost = 0;
  materials.forEach((m) => {
    const stock = prevStockToMap[m.id] || 0;
    const issue = prevIssueSumMap[m.id] || 0;
    const ncn = prevNcnSumMap[m.id] || { issueNcn: 0, returnNcn: 0 };
    const usage = (prevStockPrevMap[m.id] || 0) + issue - stock - ncn.issueNcn + ncn.returnNcn;
    prevMonthCost += usage * (m.cost || 0);
  });

  const rows = materials.map((m) => {
    const stock = stockToMap[m.id] || 0;
    const issue = issueSumMap[m.id] || 0;
    const ncn = ncnSumMap[m.id] || { issueNcn: 0, returnNcn: 0 };
    const usage = (stockPrevMap[m.id] || 0) + issue - stock - ncn.issueNcn + ncn.returnNcn;
    const cost = usage * (m.cost || 0);

    const mapping = mapByMaterialId[m.id];
    let output = null;
    let actualConsumption = null;
    if (mapping) {
      const key = mapping.operation_name + '|' + mapping.series.join(',');
      output = outputByPairKey[key] || 0;
      if (output > 0) actualConsumption = usage / output;
    }

    const stdConsumption = m.std_consumption || 0;
    const variance = actualConsumption != null && stdConsumption > 0 ? actualConsumption - stdConsumption : null;
    const variancePct = variance != null && stdConsumption > 0 ? (variance / stdConsumption) * 100 : null;

    return { material: m, usage, cost, mapping, output, actualConsumption, stdConsumption, variance, variancePct };
  });

  const totals = rows.reduce(
    (acc, r) => ({ usage: acc.usage + r.usage, cost: acc.cost + r.cost }),
    { usage: 0, cost: 0 }
  );
  const overStdCount = rows.filter((r) => r.variance != null && r.variance > 0).length;

  const isPartialMonth = month === currentMonth && end < monthEnd;

  return { workshops, selectedWorkshop: workshop, month, start, end, rows, totals, prevMonthCost, overStdCount, isPartialMonth };
}

app.get('/reports/monthly-consumption', async (req, res) => {
  const data = await computeMonthlyConsumptionReport(req.query);
  res.render('monthly_consumption', data);
});

app.get('/export/monthly-consumption.csv', async (req, res) => {
  const data = await computeMonthlyConsumptionReport(req.query);
  const lines = ['Code,Name,Workshop,Unit,Usage,UsageCost,ActualConsumption(unit/kp),StdConsumption(unit/kp),Variance,VariancePct'];
  data.rows.forEach((r) => {
    lines.push(
      [
        r.material.prod_material_code,
        r.material.name,
        r.material.workshop,
        r.material.unit,
        r.usage,
        r.cost,
        r.actualConsumption != null ? r.actualConsumption : '',
        r.stdConsumption || '',
        r.variance != null ? r.variance : '',
        r.variancePct != null ? r.variancePct : '',
      ]
        .map(csvEscape)
        .join(',')
    );
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=monthly-consumption-${data.month}.csv`);
  res.send(lines.join('\r\n'));
});

app.get('/export/monthly-consumption.xlsx', async (req, res) => {
  const data = await computeMonthlyConsumptionReport(req.query);

  const sheetRows = data.rows.map((r) => ({
    Code: r.material.prod_material_code,
    Name: r.material.name,
    Workshop: r.material.workshop,
    Unit: r.material.unit,
    Usage: r.usage,
    'Usage Cost': r.cost,
    'Actual Consumption (unit/kp)': r.actualConsumption != null ? r.actualConsumption : null,
    'STD Consumption (unit/kp)': r.stdConsumption || null,
    Variance: r.variance != null ? r.variance : null,
    'Variance %': r.variancePct != null ? r.variancePct : null,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Monthly Consumption');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=monthly-consumption-${data.month}.xlsx`);
  res.send(buffer);
});

// ---------- material request (coming soon) ----------
app.get('/material-request/1st-production', (req, res) => {
  res.render('material_request_coming_soon', { title: '1st Production' });
});

app.get('/material-request/2nd-production', (req, res) => {
  res.render('material_request_coming_soon', { title: '2nd Production' });
});

// ---------- transactions / void ----------

// Builds the transactions WHERE clause + params from query filters. Shared by the
// transactions page and its CSV export so both apply exactly the same filtering.
// Uses table aliases e (issue_entries) and m (materials).
function buildTransactionFilter(query) {
  const { q = '', material_id = '0', employee_id = '', workshop = '', shift = '', date_from = '', date_to = '' } = query;
  let clause = '';
  const params = [];
  if (q) {
    clause += ' AND (m.name LIKE ? OR m.prod_material_code LIKE ? OR m.material_code LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (material_id && material_id !== '0') {
    clause += ' AND e.material_id = ?';
    params.push(material_id);
  }
  if (employee_id) {
    clause += ' AND e.employee_id = ?';
    params.push(employee_id);
  }
  if (workshop) {
    clause += ' AND m.workshop = ?';
    params.push(workshop);
  }
  if (SHIFTS.includes(shift)) {
    clause += ' AND e.shift = ?';
    params.push(shift);
  }
  if (DATE_RE.test(date_from)) {
    clause += ' AND e.entry_date >= ?';
    params.push(date_from);
  }
  if (DATE_RE.test(date_to)) {
    clause += ' AND e.entry_date <= ?';
    params.push(date_to);
  }
  return { clause, params };
}

const TRANSACTION_SORT_COLUMNS = {
  id: 'e.id',
  date: 'e.created_at',
  entry_date: 'e.entry_date',
  material: 'm.prod_material_code',
  workshop: 'm.workshop',
  unit: 'm.unit',
  stock: 'e.current_stock',
  issue: 'e.issue_qty',
  usage: 'usage',
  issue_ncn: 'e.issue_ncn',
  return_ncn: 'e.return_ncn',
  employee_id: 'e.employee_id',
  shift: 'e.shift',
};

app.get('/transactions', async (req, res) => {
  const { q = '', material_id = '0', employee_id = '', workshop = '', shift = '', date_from = '', date_to = '' } = req.query;
  // Default to the last 3 days when no date filter is set; use filters below to widen the range.
  const hasDateFilter = DATE_RE.test(date_from) || DATE_RE.test(date_to);
  const effectiveQuery = hasDateFilter ? req.query : { ...req.query, date_from: addDays(todayStr(), -2) };
  const { clause, params } = buildTransactionFilter(effectiveQuery);

  const sort = TRANSACTION_SORT_COLUMNS[req.query.sort] ? req.query.sort : 'date';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const sortCol = TRANSACTION_SORT_COLUMNS[sort];
  const dirSql = dir === 'asc' ? 'ASC' : 'DESC';
  // e.id breaks ties, but SQL Server rejects it appearing twice when it is already the sort column.
  const tieBreak = sortCol === 'e.id' ? '' : `, e.id ${dirSql}`;

  // Per-entry usage = previous stock reading + this entry's issue - this entry's stock
  // - this entry's issue NCN + this entry's return NCN, mirroring the derivation used by the
  // CSV export. The stock_readings CTE spans the full history (unfiltered) so prev_stock stays
  // correct even when a date range is selected.
  const sql = `WITH stock_readings AS (
       SELECT id, current_stock,
              LAG(current_stock) OVER (PARTITION BY material_id ORDER BY entry_date, id) AS prev_stock
       FROM issue_entries
       WHERE voided = 0 AND current_stock IS NOT NULL
     )
     SELECT TOP 500 e.*, m.prod_material_code, m.name AS material_name, m.unit AS material_unit,
                    m.workshop AS material_workshop,
                    CASE WHEN e.voided = 0 AND e.current_stock IS NOT NULL
                         THEN COALESCE(sr.prev_stock, e.current_stock) + COALESCE(e.issue_qty, 0) - e.current_stock
                              - COALESCE(e.issue_ncn, 0) + COALESCE(e.return_ncn, 0)
                         ELSE NULL END AS usage
             FROM issue_entries e
             JOIN materials m ON m.id = e.material_id
             LEFT JOIN stock_readings sr ON sr.id = e.id
             WHERE 1=1${clause}
             ORDER BY ${sortCol} ${dirSql}${tieBreak}`;

  const transactions = await db.all(sql, params);
  const materials = await db.all('SELECT * FROM materials ORDER BY prod_material_code');
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);
  const returnQs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';

  res.render('transactions', {
    transactions,
    materials,
    workshops,
    shifts: SHIFTS,
    filters: { q, material_id: Number(material_id), employee_id, workshop, shift, date_from, date_to },
    defaultRangeApplied: !hasDateFilter,
    sort,
    dir,
    fmtDate,
    fmtDateOnly,
    returnQs,
  });
});

// ---------- transactions undo/change (self-service backdated entry) ----------

// Non-admin backdating is allowed for the two days before "today" only — yesterday or the day
// before that (the factory runs every day, so no weekend-skipping is needed here, unlike a
// business-day calendar). "Today" itself is not selectable; use /issue for same-day entry.
async function renderUndoForm(req, res, status, extra) {
  const mode = extra.mode === 'CHANGE' ? 'CHANGE' : (req.query.mode === 'CHANGE' ? 'CHANGE' : 'CREATE');
  const dateChoice = extra.dateChoice || (req.query.date_choice === 'day_before' ? 'day_before' : 'yesterday');
  const workshop = extra.workshop !== undefined ? extra.workshop : (req.query.workshop || '');
  const todayBiz = entryDayStr();
  const allowedDate = addDays(todayBiz, -1);
  const dayBeforeDate = addDays(todayBiz, -2);
  const entryDate = dateChoice === 'day_before' ? dayBeforeDate : allowedDate;
  const materialIdRaw = extra.materialId !== undefined ? extra.materialId : req.query.material_id;
  const materialId = materialIdRaw ? parseInt(materialIdRaw, 10) : null;

  const workshopMaterials = workshop ? await getIssueMaterials(workshop) : [];
  const idFilter = materialIdsFilter('material_id', workshopMaterials.map((m) => m.id));
  const existingRows = workshopMaterials.length
    ? await db.all(`SELECT * FROM issue_entries WHERE entry_date = ? AND voided = 0${idFilter.sql}`, [entryDate, ...idFilter.params])
    : [];
  const existingByMaterial = {};
  existingRows.forEach((r) => { existingByMaterial[r.material_id] = r; });

  const selectableMaterials = workshopMaterials.filter((m) => (mode === 'CHANGE' ? existingByMaterial[m.id] : !existingByMaterial[m.id]));
  const selectedEntry = materialId && mode === 'CHANGE' ? existingByMaterial[materialId] || null : null;
  const selectedMaterial = materialId ? workshopMaterials.find((m) => m.id === materialId) || null : null;
  const stockMap = await getStockAsOfMap(entryDate);
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);

  res.status(status).render('transactions_undo', {
    mode,
    dateChoice,
    entryDate,
    todayBiz,
    allowedDate,
    dayBeforeDate,
    workshop,
    workshops,
    materials: selectableMaterials,
    materialId,
    selectedMaterial,
    selectedEntry,
    stockMap,
    shifts: SHIFTS,
    error: null,
    success: null,
    negativeUsage: null,
    values: {},
    employeeId: '',
    shift: '',
    ...extra,
  });
}

app.get('/transactions/undo', async (req, res) => {
  await renderUndoForm(req, res, 200, { success: req.query.success });
});

app.post('/transactions/undo', async (req, res) => {
  const mode = req.body.mode === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const dateChoice = req.body.date_choice === 'day_before' ? 'day_before' : 'yesterday';
  const workshop = req.body.workshop || '';
  const todayBiz = entryDayStr();
  const allowedDate = addDays(todayBiz, -1);
  const dayBeforeDate = addDays(todayBiz, -2);
  const entryDate = dateChoice === 'day_before' ? dayBeforeDate : allowedDate;
  const materialId = parseInt(req.body.material_id, 10);
  const employeeId = (req.body.employee_id || '').trim();
  const shift = req.body.shift || '';

  const material = Number.isInteger(materialId) ? await db.get('SELECT * FROM materials WHERE id = ?', [materialId]) : null;

  let error = null;
  if (!KNOWN_WORKSHOPS.includes(workshop)) error = 'Please select a valid workshop.';
  else if (!material || material.workshop !== workshop) error = 'Please select a valid material.';
  else if (!EMPLOYEE_ID_RE.test(employeeId)) error = 'Employee ID must be exactly 7 digits.';
  else if (!SHIFTS.includes(shift)) error = 'Please select a valid shift (A, B, or C).';

  const raw = {};
  for (const field of NUMERIC_FIELDS) raw[field] = (req.body[field] || '').trim();
  const parsed = {};
  if (!error) {
    for (const field of NUMERIC_FIELDS) {
      if (raw[field] === '') { parsed[field] = null; continue; }
      const num = parseFloat(raw[field]);
      if (Number.isNaN(num)) { error = 'Entered values must be numbers.'; break; }
      if (num < 0) { error = 'Entered values cannot be negative.'; break; }
      parsed[field] = num;
    }
  }

  const existing = material
    ? await db.get('SELECT * FROM issue_entries WHERE material_id = ? AND entry_date = ? AND voided = 0', [materialId, entryDate])
    : null;

  if (!error) {
    if (mode === 'CREATE' && existing) {
      error = `An entry already exists for ${material.prod_material_code} on ${entryDate}. Use Change instead.`;
    } else if (mode === 'CHANGE' && !existing) {
      error = `No existing entry found for ${material.prod_material_code} on ${entryDate}. Use Create instead.`;
    }
  }

  if (error) {
    return renderUndoForm(req, res, 400, {
      mode, dateChoice, workshop, materialId: req.body.material_id, error,
      values: { [materialId]: raw }, employeeId, shift,
    });
  }

  // Same negative-usage projection as POST /issue, but for Change mode the old row's own
  // issue_qty/current_stock/issue_ncn/return_ncn must be backed out first since it hasn't been
  // voided yet.
  const priorIssueQty = existing ? (existing.issue_qty || 0) : 0;
  const priorIssueNcn = existing ? (existing.issue_ncn || 0) : 0;
  const priorReturnNcn = existing ? (existing.return_ncn || 0) : 0;
  const stockYesterdayMap = await getStockAsOfMap(addDays(entryDate, -1));
  const stockTodayMapBefore = await getStockAsOfMap(entryDate);
  const issueSumMapBefore = await getIssueSumMap(entryDate, entryDate);
  const ncnSumMapBefore = await getNcnSumMap(entryDate, entryDate);
  const projectedIssueSum = (issueSumMapBefore[materialId] || 0) - priorIssueQty + (parsed.issue_qty || 0);
  const projectedStockToday = parsed.current_stock != null ? parsed.current_stock : (stockTodayMapBefore[materialId] || 0);
  const ncnBefore = ncnSumMapBefore[materialId] || { issueNcn: 0, returnNcn: 0 };
  const projectedIssueNcn = ncnBefore.issueNcn - priorIssueNcn + (parsed.issue_ncn || 0);
  const projectedReturnNcn = ncnBefore.returnNcn - priorReturnNcn + (parsed.return_ncn || 0);
  const usage = (stockYesterdayMap[materialId] || 0) + projectedIssueSum - projectedStockToday
    - projectedIssueNcn + projectedReturnNcn;

  if (usage < 0) {
    return renderUndoForm(req, res, 400, {
      mode, dateChoice, workshop, materialId: req.body.material_id,
      negativeUsage: [{ code: material.prod_material_code, name: material.name, usage }],
      values: { [materialId]: raw }, employeeId, shift,
    });
  }

  if (mode === 'CHANGE') {
    await db.run(
      'UPDATE issue_entries SET voided = 1, voided_reason = ? WHERE id = ?',
      [`Superseded by Undo/Change (emp ${employeeId})`, existing.id]
    );
  }
  await db.run(
    `INSERT INTO issue_entries (material_id, entry_date, current_stock, issue_qty, issue_ncn, return_ncn, employee_id, shift) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [materialId, entryDate, parsed.current_stock, parsed.issue_qty, parsed.issue_ncn, parsed.return_ncn, employeeId, shift]
  );

  const fv = (v) => (v == null ? '—' : v);
  const detail = mode === 'CHANGE'
    ? `${material.prod_material_code} (${material.name}) on ${entryDate}: `
      + `stock ${fv(existing.current_stock)}→${fv(parsed.current_stock)}, `
      + `issue ${fv(existing.issue_qty)}→${fv(parsed.issue_qty)}, `
      + `issue NCN ${fv(existing.issue_ncn)}→${fv(parsed.issue_ncn)}, `
      + `return NCN ${fv(existing.return_ncn)}→${fv(parsed.return_ncn)}`
    : `${material.prod_material_code} (${material.name}) on ${entryDate}: `
      + `stock=${fv(parsed.current_stock)}, issue=${fv(parsed.issue_qty)}, `
      + `issue NCN=${fv(parsed.issue_ncn)}, return NCN=${fv(parsed.return_ncn)}`;

  await db.run(
    `INSERT INTO tickets (emp_no, shift, workshop, detail, type) VALUES (?, ?, ?, ?, ?)`,
    [employeeId, shift, workshop, detail, mode]
  );

  res.redirect(`/transactions/undo?success=1&mode=${encodeURIComponent(mode)}&date_choice=${encodeURIComponent(dateChoice)}&workshop=${encodeURIComponent(workshop)}`);
});

app.post('/transactions/:id/void', requirePermission('transactions_manage'), async (req, res) => {
  const entry = await db.get('SELECT * FROM issue_entries WHERE id = ?', [req.params.id]);
  if (entry && !entry.voided) {
    const reason = (req.body.voided_reason || '').trim() || 'No reason given';
    await db.run('UPDATE issue_entries SET voided = 1, voided_reason = ? WHERE id = ?', [reason, req.params.id]);
  }
  const qs = req.body.return_qs || '';
  res.redirect(qs ? `/transactions?${qs}` : '/transactions');
});

app.post('/transactions/bulk-void', requirePermission('transactions_manage'), async (req, res) => {
  const ids = [].concat(req.body.ids || []).map((id) => parseInt(id, 10)).filter(Number.isInteger);
  const reason = (req.body.voided_reason || '').trim() || 'No reason given';
  for (const id of ids) {
    await db.run('UPDATE issue_entries SET voided = 1, voided_reason = ? WHERE id = ? AND voided = 0', [reason, id]);
  }
  const qs = req.body.return_qs || '';
  res.redirect(qs ? `/transactions?${qs}` : '/transactions');
});

app.get('/transactions/:id/edit', requirePermission('transactions_manage'), async (req, res) => {
  const entry = await db.get(
    `SELECT e.*, m.prod_material_code, m.name AS material_name, m.unit AS material_unit
     FROM issue_entries e JOIN materials m ON m.id = e.material_id
     WHERE e.id = ?`,
    [req.params.id]
  );
  if (!entry) return res.redirect('/transactions');
  const materials = await db.all('SELECT * FROM materials ORDER BY prod_material_code');
  const returnQs = req.query.return_qs || '';
  res.render('transaction_edit', { entry, materials, shifts: SHIFTS, error: null, fmtDate, returnQs });
});

app.post('/transactions/:id/edit', requirePermission('transactions_manage'), async (req, res) => {
  const entry = await db.get('SELECT * FROM issue_entries WHERE id = ?', [req.params.id]);
  if (!entry) return res.redirect('/transactions');
  const materials = await db.all('SELECT * FROM materials ORDER BY prod_material_code');
  const returnQs = req.body.return_qs || '';

  const materialId = parseInt(req.body.material_id, 10);
  const employeeId = (req.body.employee_id || '').trim();
  const shift = req.body.shift || '';
  const entryDate = (req.body.entry_date || '').trim();
  const voided = req.body.voided === '1';
  const voidedReason = (req.body.voided_reason || '').trim() || (voided ? 'No reason given' : '');
  const raw = {};
  for (const field of NUMERIC_FIELDS) raw[field] = (req.body[field] || '').trim();

  let error = null;
  const material = materials.find((m) => m.id === materialId);
  if (!material) error = 'Please select a valid material.';
  else if (!DATE_RE.test(entryDate)) error = 'Please enter a valid entry date.';
  else if (!EMPLOYEE_ID_RE.test(employeeId)) error = 'Employee ID must be exactly 7 digits.';
  else if (!SHIFTS.includes(shift)) error = 'Please select a valid shift (A, B, or C).';

  const parsed = {};
  if (!error) {
    for (const field of NUMERIC_FIELDS) {
      if (raw[field] === '') {
        parsed[field] = null;
        continue;
      }
      const num = parseFloat(raw[field]);
      if (Number.isNaN(num)) {
        error = 'Entered values must be numbers.';
        break;
      }
      if (num < 0) {
        error = 'Entered values cannot be negative.';
        break;
      }
      parsed[field] = num;
    }
  }

  if (error) {
    const currentMaterial = material || (await db.get('SELECT prod_material_code, name, unit FROM materials WHERE id = ?', [entry.material_id]));
    return res.status(400).render('transaction_edit', {
      entry: {
        ...entry,
        material_id: materialId || entry.material_id,
        prod_material_code: currentMaterial.prod_material_code,
        material_name: currentMaterial.name,
        material_unit: currentMaterial.unit,
        entry_date: entryDate,
        current_stock: raw.current_stock,
        issue_qty: raw.issue_qty,
        issue_ncn: raw.issue_ncn,
        return_ncn: raw.return_ncn,
        employee_id: employeeId,
        shift,
        voided,
        voided_reason: voidedReason,
      },
      materials,
      shifts: SHIFTS,
      error,
      fmtDate,
      returnQs,
    });
  }

  await db.run(
    `UPDATE issue_entries SET material_id = ?, entry_date = ?, current_stock = ?, issue_qty = ?, issue_ncn = ?, return_ncn = ?, employee_id = ?, shift = ?, voided = ?, voided_reason = ?
     WHERE id = ?`,
    [materialId, entryDate, parsed.current_stock, parsed.issue_qty, parsed.issue_ncn, parsed.return_ncn, employeeId, shift, voided, voidedReason, req.params.id]
  );

  res.redirect(returnQs ? `/transactions?${returnQs}` : '/transactions');
});

// ---------- tickets (request a data correction) ----------

app.get('/tickets/new', (req, res) => {
  res.render('ticket_new', {
    workshops: KNOWN_WORKSHOPS,
    shifts: SHIFTS,
    error: null,
    success: req.query.success,
    values: {},
  });
});

app.post('/tickets/new', (req, res, next) => {
  ticketUpload.single('attachment')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).render('ticket_new', {
        workshops: KNOWN_WORKSHOPS,
        shifts: SHIFTS,
        error: 'Attachment must be 10MB or smaller.',
        success: null,
        values: { emp_no: req.body.emp_no, shift: req.body.shift, workshop: req.body.workshop, detail: req.body.detail },
      });
    }
    if (err && err.message === 'UNSUPPORTED_FILE_TYPE') {
      return res.status(400).render('ticket_new', {
        workshops: KNOWN_WORKSHOPS,
        shifts: SHIFTS,
        error: `Unsupported attachment type. Allowed: ${TICKET_ATTACHMENT_EXTS.join(', ')}`,
        success: null,
        values: { emp_no: req.body.emp_no, shift: req.body.shift, workshop: req.body.workshop, detail: req.body.detail },
      });
    }
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  const empNo = (req.body.emp_no || '').trim();
  const shift = req.body.shift || '';
  const workshop = req.body.workshop || '';
  const detail = (req.body.detail || '').trim();
  const attachment = req.file;

  let error = null;
  if (!/^\d+$/.test(empNo)) error = 'Emp No. must be a number.';
  else if (!SHIFTS.includes(shift)) error = 'Please select a valid shift (A, B, or C).';
  else if (!KNOWN_WORKSHOPS.includes(workshop)) error = 'Please select a valid workshop.';
  else if (!detail) error = 'Detail is required.';

  if (error) {
    if (attachment) fs.unlink(attachment.path, () => {});
    return res.status(400).render('ticket_new', {
      workshops: KNOWN_WORKSHOPS,
      shifts: SHIFTS,
      error,
      success: null,
      values: { emp_no: empNo, shift, workshop, detail },
    });
  }

  await db.run(
    `INSERT INTO tickets (emp_no, shift, workshop, detail, attachment_path, attachment_name) VALUES (?, ?, ?, ?, ?, ?)`,
    [empNo, shift, workshop, detail, attachment ? attachment.filename : null, attachment ? fixUploadedFilename(attachment.originalname) : null]
  );

  res.redirect('/tickets/new?success=1');
});

const TICKET_TYPES = ['MANUAL', 'CHANGE', 'CREATE'];

app.get('/tickets', async (req, res) => {
  const status = req.query.status === 'RESOLVED' ? 'RESOLVED' : req.query.status === 'OPEN' ? 'OPEN' : '';
  const type = TICKET_TYPES.includes(req.query.type) ? req.query.type : '';
  const dateFrom = DATE_RE.test(req.query.date_from) ? req.query.date_from : '';
  const dateTo = DATE_RE.test(req.query.date_to) ? req.query.date_to : '';
  let sql = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (dateFrom) {
    sql += ' AND CAST(created_at AS DATE) >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND CAST(created_at AS DATE) <= ?';
    params.push(dateTo);
  }
  sql += ' ORDER BY created_at DESC, id DESC';
  const tickets = await db.all(sql, params);
  const openCount = (await db.get("SELECT COUNT(*) c FROM tickets WHERE status = 'OPEN'")).c;
  const returnQs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';

  const workshopTypeCounts = {
    workshops: KNOWN_WORKSHOPS,
    series: TICKET_TYPES.map((tt) => ({
      type: tt,
      counts: KNOWN_WORKSHOPS.map((w) => tickets.filter((t) => t.workshop === w && t.type === tt).length),
    })),
  };

  res.render('tickets', { tickets, status, type, dateFrom, dateTo, openCount, fmtDate, workshopTypeCounts, returnQs });
});

app.get('/tickets/:id/attachment', async (req, res) => {
  const ticket = await db.get('SELECT attachment_path, attachment_name FROM tickets WHERE id = ?', [req.params.id]);
  if (!ticket || !ticket.attachment_path) return res.status(404).send('No attachment found.');
  const filePath = path.join(TICKET_UPLOAD_DIR, path.basename(ticket.attachment_path));
  res.download(filePath, ticket.attachment_name || path.basename(filePath));
});

app.post('/tickets/:id/resolve', requirePermission('tickets_manage'), async (req, res) => {
  const note = (req.body.resolved_note || '').trim();
  await db.run(
    `UPDATE tickets SET status = 'RESOLVED', resolved_at = SYSDATETIME(), resolved_note = ? WHERE id = ?`,
    [note, req.params.id]
  );
  const qs = req.body.return_qs || '';
  res.redirect(qs ? `/tickets?${qs}` : '/tickets');
});

app.post('/tickets/:id/delete', requirePermission('tickets_manage'), async (req, res) => {
  const ticket = await db.get('SELECT attachment_path FROM tickets WHERE id = ?', [req.params.id]);
  await db.run('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  if (ticket && ticket.attachment_path) {
    fs.unlink(path.join(TICKET_UPLOAD_DIR, path.basename(ticket.attachment_path)), () => {});
  }
  const qs = req.body.return_qs || '';
  res.redirect(qs ? `/tickets?${qs}` : '/tickets');
});

// ---------- exports ----------

// Daily stock-cutoff grid: one row per material per calendar day in [from, to], even for days
// with no issue_entries row. Current Stock forward-fills from the last day that actually has a
// reading (mirrors getStockAsOfMap's carry-forward), so paper-style reports never show a gap.
// Ignores employee_id/shift filters since a single day/material can span multiple entries.
async function getDailyStockGridRows({ workshop, materialId, q, from, to }) {
  let matSql = 'SELECT * FROM materials WHERE 1=1';
  const matParams = [];
  if (workshop) { matSql += ' AND workshop = ?'; matParams.push(workshop); }
  if (materialId && materialId !== '0') { matSql += ' AND id = ?'; matParams.push(materialId); }
  if (q) {
    matSql += ' AND (name LIKE ? OR prod_material_code LIKE ? OR material_code LIKE ?)';
    const like = `%${q}%`;
    matParams.push(like, like, like);
  }
  matSql += ' ORDER BY prod_material_code';
  const materials = await db.all(matSql, matParams);
  if (!materials.length) return [];
  const idFilter = materialIdsFilter('material_id', materials.map((m) => m.id));

  // Stock readings up to `to`, oldest first, for forward-filling Current Stock day by day.
  const stockHistory = await db.all(
    `SELECT material_id, entry_date, current_stock FROM issue_entries
     WHERE voided = 0 AND current_stock IS NOT NULL AND entry_date <= ?${idFilter.sql}
     ORDER BY material_id, entry_date, id`,
    [to, ...idFilter.params]
  );
  const stockHistoryByMaterial = {};
  stockHistory.forEach((r) => {
    (stockHistoryByMaterial[r.material_id] = stockHistoryByMaterial[r.material_id] || [])
      .push({ date: dateKey(r.entry_date), stock: r.current_stock });
  });

  // Raw entries within the report range, for per-day issue/NCN totals; last entry of the
  // day (by id) wins for the displayed employee/shift.
  const dayEntries = await db.all(
    `SELECT material_id, entry_date, issue_qty, issue_ncn, return_ncn, employee_id, shift
     FROM issue_entries
     WHERE voided = 0 AND entry_date BETWEEN ? AND ?${idFilter.sql}
     ORDER BY material_id, entry_date, id`,
    [from, to, ...idFilter.params]
  );
  const dayMap = {};
  dayEntries.forEach((r) => {
    const key = `${r.material_id}|${dateKey(r.entry_date)}`;
    const cur = dayMap[key] || { issueQty: 0, issueNcn: 0, returnNcn: 0, employeeId: '', shift: '', hasEntry: false };
    cur.issueQty += r.issue_qty || 0;
    cur.issueNcn += r.issue_ncn || 0;
    cur.returnNcn += r.return_ncn || 0;
    cur.employeeId = r.employee_id || cur.employeeId;
    cur.shift = r.shift || cur.shift;
    cur.hasEntry = true;
    dayMap[key] = cur;
  });

  const dates = buildDateRange(from, to);
  const rows = [];
  for (const m of materials) {
    const history = stockHistoryByMaterial[m.id] || [];
    let ptr = 0;
    let prevStock = 0;
    while (ptr < history.length && history[ptr].date < from) { prevStock = history[ptr].stock; ptr++; }
    for (const date of dates) {
      let stockToday = prevStock;
      while (ptr < history.length && history[ptr].date <= date) { stockToday = history[ptr].stock; ptr++; }
      const day = dayMap[`${m.id}|${date}`] || { issueQty: 0, issueNcn: 0, returnNcn: 0, employeeId: '', shift: '', hasEntry: false };
      const usage = prevStock + day.issueQty - stockToday - day.issueNcn + day.returnNcn;
      rows.push({
        date, material: m, currentStock: stockToday, issueQty: day.issueQty,
        issueNcn: day.issueNcn, returnNcn: day.returnNcn, usage,
        employeeId: day.employeeId, shift: day.shift, hasEntry: day.hasEntry,
      });
      prevStock = stockToday;
    }
  }
  return rows;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get('/export/materials.csv', async (req, res) => {
  const workshop = req.query.workshop || '';
  const q = req.query.q || '';
  const today = todayStr();
  const from = req.query.from || today;
  const to = req.query.to || today;

  let rows = await getMaterialsListRows({ workshop, q, from, to });
  rows.sort((a, b) => (a.material.prod_material_code || '').localeCompare(b.material.prod_material_code || ''));

  const lines = ['ProdMaterialCode,ErpCode,Name,Unit,Workshop,Stock,Issue,Usage,Hold'];
  for (const { material: m, stock, issue, usage, hold } of rows) {
    lines.push(
      [m.prod_material_code, m.material_code, m.name, m.unit, m.workshop, stock, issue, usage, hold]
        .map(csvEscape)
        .join(',')
    );
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=materials.csv');
  res.send(lines.join('\r\n'));
});

app.get('/export/transactions.csv', async (req, res) => {
  // Daily stock-cutoff mode: one row per material per day for every day in range, with
  // Current Stock carried forward on days with no entry (see getDailyStockGridRows).
  if (req.query.daily === '1') {
    const today = todayStr();
    const from = DATE_RE.test(req.query.date_from) ? req.query.date_from : addDays(today, -2);
    const to = DATE_RE.test(req.query.date_to) ? req.query.date_to : today;
    const rows = await getDailyStockGridRows({
      workshop: req.query.workshop || '',
      materialId: req.query.material_id || '0',
      q: req.query.q || '',
      from,
      to,
    });

    const lines = ['Date,MaterialCode,MaterialName,Unit,Workshop,CurrentStock,Issue,Usage,IssueNCN,ReturnNCN,EmployeeId,Shift,HasEntry'];
    for (const r of rows) {
      lines.push(
        [
          r.date,
          r.material.prod_material_code,
          r.material.name,
          r.material.unit,
          r.material.workshop,
          r.currentStock,
          r.issueQty,
          r.usage,
          r.issueNcn,
          r.returnNcn,
          r.employeeId,
          r.shift,
          r.hasEntry ? 'YES' : '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=daily-stock.csv');
    return res.send(lines.join('\r\n'));
  }

  // Per-entry usage = previous stock reading + this entry's issue - this entry's stock
  // - this entry's issue NCN + this entry's return NCN, mirroring the derivation used elsewhere.
  // Only defined for non-voided rows that carry a stock reading; the prev-stock chain likewise
  // ignores voided entries and rows with no stock. The stock_readings CTE spans the full history
  // (unfiltered) so prev_stock stays correct even when a date range is selected; the user's
  // filters are applied only to the outer result set.
  const { clause, params } = buildTransactionFilter(req.query);
  const transactions = await db.all(
    `WITH stock_readings AS (
       SELECT id, current_stock,
              LAG(current_stock) OVER (PARTITION BY material_id ORDER BY entry_date, id) AS prev_stock
       FROM issue_entries
       WHERE voided = 0 AND current_stock IS NOT NULL
     )
     SELECT e.*, m.prod_material_code, m.name AS material_name, m.workshop AS material_workshop, m.unit AS material_unit,
            CASE WHEN e.voided = 0 AND e.current_stock IS NOT NULL
                 THEN COALESCE(sr.prev_stock, e.current_stock) + COALESCE(e.issue_qty, 0) - e.current_stock
                      - COALESCE(e.issue_ncn, 0) + COALESCE(e.return_ncn, 0)
                 ELSE NULL END AS usage
     FROM issue_entries e
     JOIN materials m ON m.id = e.material_id
     LEFT JOIN stock_readings sr ON sr.id = e.id
     WHERE 1=1${clause}
     ORDER BY e.entry_date DESC, e.id DESC`,
    params
  );

  const lines = ['Date,MaterialCode,MaterialName,Unit,Workshop,CurrentStock,Issue,Usage,IssueNCN,ReturnNCN,EmployeeId,Shift,Voided,VoidedReason'];
  for (const t of transactions) {
    lines.push(
      [
        fmtDateOnly(t.entry_date),
        t.prod_material_code,
        t.material_name,
        t.material_unit,
        t.material_workshop,
        t.current_stock,
        t.issue_qty,
        t.usage,
        t.issue_ncn,
        t.return_ncn,
        t.employee_id,
        t.shift,
        t.voided ? 'YES' : '',
        t.voided_reason,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
  res.send(lines.join('\r\n'));
});

// Materials by usage cost, respecting the dashboard's current filters.
app.get('/export/cost.csv', async (req, res) => {
  const { filteredMaterials, workshop, from, to } = await resolveDashboardFilters(req.query);
  const costRows = await computeCostRows(filteredMaterials, workshop, from, to);

  const lines = ['Code,Name,Workshop,Usage,Unit,UsageCost,UnitCost'];
  for (const row of costRows) {
    lines.push(
      [
        row.material.prod_material_code,
        row.material.name,
        row.material.workshop,
        row.usage,
        row.material.unit,
        row.value,
        row.cost,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=materials-by-usage-cost.csv');
  res.send(lines.join('\r\n'));
});

const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function lanAddresses() {
  const nets = require('node:os').networkInterfaces();
  const addrs = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

async function main() {
  const requiredSettings = ['DB_SERVER', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ADMIN_PASSWORD'];
  const missingSettings = requiredSettings.filter((name) => !process.env[name]);
  if (missingSettings.length > 0) {
    throw new Error(`Missing required environment settings: ${missingSettings.join(', ')}`);
  }
  await db.ensureSchema();
  await seedMasterAdmin();
  app.listen(PORT, HOST, () => {
    console.log(`Material Management running on port ${PORT}`);
    console.log(`  Local:   http://localhost:${PORT}`);
    if (!LOOPBACK_HOSTS.has(HOST)) {
      for (const ip of lanAddresses()) {
        console.log(`  Network: http://${ip}:${PORT}`);
      }
    }
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
