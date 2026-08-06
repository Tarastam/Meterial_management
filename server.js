const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const db = require('./src/db');
const { KNOWN_UNITS, KNOWN_WORKSHOPS } = require('./src/constants');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'static')));

// ---------- ticket attachment uploads ----------

const TICKET_UPLOAD_DIR = path.join(__dirname, 'uploads', 'tickets');
fs.mkdirSync(TICKET_UPLOAD_DIR, { recursive: true });

const TICKET_ATTACHMENT_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx'];

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

// ---------- admin auth ----------

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_COOKIE = 'admin_session';
const ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');

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

app.use((req, res, next) => {
  req.isAdmin = parseCookies(req)[ADMIN_COOKIE] === ADMIN_TOKEN;
  res.locals.isAdmin = req.isAdmin;
  res.locals.fmtNum = fmtNum;
  res.locals.fmtDateOnly = fmtDateOnly;
  next();
});

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

app.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null, next: req.query.next || '/transactions' });
});

app.post('/admin/login', (req, res) => {
  const password = req.body.password || '';
  const next = req.body.next || '/transactions';
  if (password !== ADMIN_PASSWORD) {
    return res.status(400).render('admin_login', { error: 'Incorrect password.', next });
  }
  res.cookie(ADMIN_COOKIE, ADMIN_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.redirect(next);
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.redirect('/');
});

// ---------- helpers ----------

function todayStr() {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
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

// Per-day totals of issue_qty and derived usage (prevStock + issue - stock), summed across
// materials matching the workshop/shift/material filters, for every day in [fromDate, toDate].
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
       SELECT e.id, e.material_id, e.entry_date, e.issue_qty, e.current_stock
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
     with_prev AS (
       SELECT material_id, entry_date, current_stock,
              LAG(current_stock) OVER (PARTITION BY material_id ORDER BY entry_date) AS prev_stock
       FROM day_stock
     )
     SELECT s.entry_date,
            SUM(COALESCE(s.prev_stock, s.current_stock) + COALESCE(i.issue_sum, 0) - s.current_stock) AS total
     FROM with_prev s
     LEFT JOIN day_issue i ON i.material_id = s.material_id AND i.entry_date = s.entry_date
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
       SELECT e.id, e.material_id, e.entry_date, e.issue_qty, e.current_stock
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
     with_prev AS (
       SELECT material_id, entry_date, current_stock,
              LAG(current_stock) OVER (PARTITION BY material_id ORDER BY entry_date) AS prev_stock
       FROM day_stock
     )
     SELECT s.material_id, s.entry_date,
            COALESCE(s.prev_stock, s.current_stock) + COALESCE(i.issue_sum, 0) - s.current_stock AS total
     FROM with_prev s
     LEFT JOIN day_issue i ON i.material_id = s.material_id AND i.entry_date = s.entry_date
     WHERE s.entry_date BETWEEN ? AND ?`,
    [...filterParams, fromDate, toDate]
  );

  const dates = buildDateRange(fromDate, toDate);
  const issueByMaterial = {};
  const usageByMaterial = {};
  const materialIdsSeen = new Set();

  issueRows.forEach((r) => {
    materialIdsSeen.add(r.material_id);
    (issueByMaterial[r.material_id] = issueByMaterial[r.material_id] || {})[dateKey(r.entry_date)] = r.total;
  });
  usageRows.forEach((r) => {
    materialIdsSeen.add(r.material_id);
    (usageByMaterial[r.material_id] = usageByMaterial[r.material_id] || {})[dateKey(r.entry_date)] = r.total;
  });

  return { dates, materialIds: [...materialIdsSeen], issueByMaterial, usageByMaterial };
}

function sumDaily(daily) {
  return daily.reduce(
    (acc, d) => ({ issue: acc.issue + d.issue, usage: acc.usage + d.usage }),
    { issue: 0, usage: 0 }
  );
}

function fmtDate(date) {
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
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
  return costMaterials
    .map((m) => {
      const stock = stockToMap[m.id] || 0;
      const issue = issueSumRangeMap[m.id] || 0;
      const usage = (stockPrevMap[m.id] || 0) + issue - stock;
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

  const cutoff = addDays(today, -30);
  const topFilter = materialIdsFilter('e.material_id', materialIds);
  const topIssuedRows = await db.all(
    `SELECT TOP 5 m.id, m.name, m.prod_material_code, SUM(e.issue_qty) AS total_out
     FROM issue_entries e
     JOIN materials m ON m.id = e.material_id
     WHERE e.voided = 0 AND e.issue_qty IS NOT NULL AND e.entry_date >= ?${topFilter.sql}
     GROUP BY m.id, m.name, m.prod_material_code
     ORDER BY total_out DESC`,
    [cutoff, ...topFilter.params]
  );
  const maxOut = topIssuedRows.reduce((max, r) => Math.max(max, r.total_out), 0) || 1;

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

  res.render('dashboard', {
    totalMaterials: materials.length,
    transactionsToday,
    recentTransactions,
    topIssuedRows,
    maxOut,
    costRows,
    fmtDate,
    materials: materialOptions,
    workshops,
    shifts: SHIFTS,
    filters: { workshop, shift, from, to, material_id: selectedMaterialId, q },
    dailyChartData,
    curMonthTotals,
    prevMonthTotals,
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
    const usage = (stockYesterdayMap[m.id] || 0) + issue - stock;
    const ncn = ncnSumMap[m.id] || { issueNcn: 0, returnNcn: 0 };
    const hold = ncn.issueNcn - ncn.returnNcn;
    return { material: m, stock, usage, issue, hold };
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
    if (sortCol === 'stock' || sortCol === 'usage' || sortCol === 'issue' || sortCol === 'hold') {
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

  res.render('materials_list', {
    rows,
    workshops,
    selectedWorkshop: workshop,
    q,
    from,
    to,
    sort,
    dir,
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

app.get('/materials/new', requireAdmin, async (req, res) => {
  res.render('material_form', {
    material: { prod_material_code: await getNextMaterialCode() },
    units: KNOWN_UNITS,
    workshops: KNOWN_WORKSHOPS,
    error: null,
    editingId: null,
  });
});

app.post('/materials/new', requireAdmin, async (req, res) => {
  const { material_code = '', name, unit, workshop, min_stock } = req.body;
  const minStock = parseFloat(min_stock) || 0;

  let error = null;
  if (minStock < 0) {
    error = 'Minimum stock cannot be negative.';
  }

  if (error) {
    return res.status(400).render('material_form', {
      material: { prod_material_code: await getNextMaterialCode(), material_code, name, unit, workshop, min_stock: minStock },
      units: KNOWN_UNITS,
      workshops: KNOWN_WORKSHOPS,
      error,
      editingId: null,
    });
  }

  // Loop to absorb the rare case where another admin grabs the same next code first.
  for (let attempt = 0; attempt < 5; attempt++) {
    const prodMaterialCode = await getNextMaterialCode();
    try {
      await db.run(
        `INSERT INTO materials (prod_material_code, material_code, name, unit, workshop, min_stock)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [prodMaterialCode, material_code.trim(), name.trim(), unit.trim(), workshop.trim(), minStock]
      );
      return res.redirect('/materials');
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
});

app.get('/materials/:id/edit', requireAdmin, async (req, res) => {
  const material = await db.get('SELECT * FROM materials WHERE id = ?', [req.params.id]);
  res.render('material_form', {
    material,
    units: KNOWN_UNITS,
    workshops: KNOWN_WORKSHOPS,
    error: null,
    editingId: req.params.id,
  });
});

app.post('/materials/:id/edit', requireAdmin, async (req, res) => {
  const materialId = req.params.id;
  const { material_code = '', name, unit, workshop, min_stock } = req.body;
  const prodMaterialCode = (req.body.prod_material_code || '').trim();
  const minStock = parseFloat(min_stock) || 0;

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
      },
      units: KNOWN_UNITS,
      workshops: KNOWN_WORKSHOPS,
      error,
      editingId: materialId,
    });
  }

  await db.run(
    `UPDATE materials SET prod_material_code = ?, material_code = ?, name = ?, unit = ?, workshop = ?, min_stock = ?
     WHERE id = ?`,
    [prodMaterialCode, material_code.trim(), name.trim(), unit.trim(), workshop.trim(), minStock, materialId]
  );

  res.redirect('/materials');
});

app.post('/materials/:id/delete', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM issue_entries WHERE material_id = ?', [req.params.id]);
  await db.run('DELETE FROM materials WHERE id = ?', [req.params.id]);
  res.redirect('/materials');
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
  const entryDate = extra.entryDate || todayStr();
  const materials = await getIssueMaterials(workshop);
  const stockMap = await getStockAsOfMap(entryDate);
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);
  res.status(status).render('issue', {
    materials,
    stockMap,
    shifts: SHIFTS,
    workshops,
    selectedWorkshop: workshop,
    entryDate,
    today: todayStr(),
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
  const entryDate = req.isAdmin && DATE_RE.test(req.query.date) ? req.query.date : todayStr();
  await renderIssueForm(req, res, 200, { success: req.query.success, workshop: req.query.workshop || '', entryDate });
});

app.post('/issue', async (req, res) => {
  const workshop = req.body.workshop || '';
  const materials = await getIssueMaterials(workshop);
  const employeeId = (req.body.employee_id || '').trim();
  const shift = req.body.shift || '';
  const entryDate = req.isAdmin && DATE_RE.test(req.body.entry_date) ? req.body.entry_date : todayStr();

  let error = null;
  if (!EMPLOYEE_ID_RE.test(employeeId)) {
    error = 'Employee ID must be exactly 7 digits.';
  } else if (!SHIFTS.includes(shift)) {
    error = 'Please select a valid shift (A, B, or C).';
  }

  const values = {};
  const rowsToInsert = [];
  for (const m of materials) {
    const raw = {};
    for (const field of NUMERIC_FIELDS) {
      raw[field] = (req.body[`${field}_${m.id}`] || '').trim();
    }
    values[m.id] = raw;
    if (!raw.current_stock && !raw.issue_qty && !raw.issue_ncn && !raw.return_ncn) continue;

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
    rowsToInsert.push({ materialId: m.id, ...parsed });
  }

  if (!rowsToInsert.length && !error) {
    error = 'Enter at least one value.';
  }

  // Block accidental double-entry of the same material on the same day. Admins are exempt
  // since they intentionally re-enter/backdate records to correct mistakes.
  if (!error && rowsToInsert.length && !req.isAdmin) {
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
  const stockYesterdayMap = await getStockAsOfMap(addDays(entryDate, -1));
  const stockTodayMapBefore = await getStockAsOfMap(entryDate);
  const issueSumMapBefore = await getIssueSumMap(entryDate, entryDate);
  const negativeUsage = [];
  for (const row of rowsToInsert) {
    const projectedIssueSum = (issueSumMapBefore[row.materialId] || 0) + (row.issue_qty || 0);
    const projectedStockToday = row.current_stock != null ? row.current_stock : (stockTodayMapBefore[row.materialId] || 0);
    const usage = (stockYesterdayMap[row.materialId] || 0) + projectedIssueSum - projectedStockToday;
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

app.get('/consumption', async (req, res) => {
  const workshop = req.query.workshop || '';
  const materialId = req.query.material_id || '';
  const today = todayStr();
  const from = req.query.from || today;
  const to = req.query.to || today;
  const outputRaw = (req.query.output || '').trim();

  const materials = await getIssueMaterials(workshop);
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);

  let result = null;
  let error = null;
  if (materialId) {
    const material = await db.get('SELECT * FROM materials WHERE id = ?', [materialId]);
    if (!material) {
      error = 'Material not found.';
    } else {
      const stockYesterday = (await getStockAsOfMap(addDays(from, -1)))[material.id] || 0;
      const stockToday = (await getStockAsOfMap(to))[material.id] || 0;
      const issueSum = (await getIssueSumMap(from, to))[material.id] || 0;
      const usage = stockYesterday + issueSum - stockToday;

      let output = null;
      let consumption = null;
      if (outputRaw !== '') {
        output = parseFloat(outputRaw);
        if (Number.isNaN(output)) {
          error = 'Output must be a number.';
        } else if (output <= 0) {
          error = 'Output must be greater than zero.';
        } else {
          consumption = usage / output;
        }
      }

      result = { material, usage, output, consumption };
    }
  }

  res.render('consumption', {
    materials,
    workshops,
    selectedWorkshop: workshop,
    selectedMaterialId: materialId,
    from,
    to,
    outputRaw,
    result,
    error,
  });
});

// ---------- transactions / void ----------

// Builds the transactions WHERE clause + params from query filters. Shared by the
// transactions page and its CSV export so both apply exactly the same filtering.
// Uses table aliases e (issue_entries) and m (materials).
function buildTransactionFilter(query) {
  const { material_id = '0', employee_id = '', workshop = '', shift = '', date_from = '', date_to = '' } = query;
  let clause = '';
  const params = [];
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
  issue_ncn: 'e.issue_ncn',
  return_ncn: 'e.return_ncn',
  employee_id: 'e.employee_id',
  shift: 'e.shift',
};

app.get('/transactions', async (req, res) => {
  const { material_id = '0', employee_id = '', workshop = '', shift = '', date_from = '', date_to = '' } = req.query;
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

  const sql = `SELECT TOP 500 e.*, m.prod_material_code, m.name AS material_name, m.unit AS material_unit,
                    m.workshop AS material_workshop
             FROM issue_entries e
             JOIN materials m ON m.id = e.material_id
             WHERE 1=1${clause}
             ORDER BY ${sortCol} ${dirSql}${tieBreak}`;

  const transactions = await db.all(sql, params);
  const materials = await db.all('SELECT * FROM materials ORDER BY prod_material_code');
  const workshops = (await db.all('SELECT DISTINCT workshop FROM materials ORDER BY workshop')).map((r) => r.workshop);

  res.render('transactions', {
    transactions,
    materials,
    workshops,
    shifts: SHIFTS,
    filters: { material_id: Number(material_id), employee_id, workshop, shift, date_from, date_to },
    defaultRangeApplied: !hasDateFilter,
    sort,
    dir,
    fmtDate,
    fmtDateOnly,
  });
});

app.post('/transactions/:id/void', requireAdmin, async (req, res) => {
  const entry = await db.get('SELECT * FROM issue_entries WHERE id = ?', [req.params.id]);
  if (entry && !entry.voided) {
    const reason = (req.body.voided_reason || '').trim() || 'No reason given';
    await db.run('UPDATE issue_entries SET voided = 1, voided_reason = ? WHERE id = ?', [reason, req.params.id]);
  }
  res.redirect('/transactions');
});

app.get('/transactions/:id/edit', requireAdmin, async (req, res) => {
  const entry = await db.get(
    `SELECT e.*, m.prod_material_code, m.name AS material_name, m.unit AS material_unit
     FROM issue_entries e JOIN materials m ON m.id = e.material_id
     WHERE e.id = ?`,
    [req.params.id]
  );
  if (!entry) return res.redirect('/transactions');
  const materials = await db.all('SELECT * FROM materials ORDER BY prod_material_code');
  res.render('transaction_edit', { entry, materials, shifts: SHIFTS, error: null, fmtDate });
});

app.post('/transactions/:id/edit', requireAdmin, async (req, res) => {
  const entry = await db.get('SELECT * FROM issue_entries WHERE id = ?', [req.params.id]);
  if (!entry) return res.redirect('/transactions');
  const materials = await db.all('SELECT * FROM materials ORDER BY prod_material_code');

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
    });
  }

  await db.run(
    `UPDATE issue_entries SET material_id = ?, entry_date = ?, current_stock = ?, issue_qty = ?, issue_ncn = ?, return_ncn = ?, employee_id = ?, shift = ?, voided = ?, voided_reason = ?
     WHERE id = ?`,
    [materialId, entryDate, parsed.current_stock, parsed.issue_qty, parsed.issue_ncn, parsed.return_ncn, employeeId, shift, voided, voidedReason, req.params.id]
  );

  res.redirect('/transactions');
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
    [empNo, shift, workshop, detail, attachment ? attachment.filename : null, attachment ? attachment.originalname : null]
  );

  res.redirect('/tickets/new?success=1');
});

app.get('/tickets', requireAdmin, async (req, res) => {
  const status = req.query.status === 'RESOLVED' ? 'RESOLVED' : req.query.status === 'OPEN' ? 'OPEN' : '';
  let sql = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC, id DESC';
  const tickets = await db.all(sql, params);
  const openCount = (await db.get("SELECT COUNT(*) c FROM tickets WHERE status = 'OPEN'")).c;

  res.render('tickets', { tickets, status, openCount, fmtDate });
});

app.get('/tickets/:id/attachment', requireAdmin, async (req, res) => {
  const ticket = await db.get('SELECT attachment_path, attachment_name FROM tickets WHERE id = ?', [req.params.id]);
  if (!ticket || !ticket.attachment_path) return res.status(404).send('No attachment found.');
  const filePath = path.join(TICKET_UPLOAD_DIR, path.basename(ticket.attachment_path));
  res.download(filePath, ticket.attachment_name || path.basename(filePath));
});

app.post('/tickets/:id/resolve', requireAdmin, async (req, res) => {
  const note = (req.body.resolved_note || '').trim();
  await db.run(
    `UPDATE tickets SET status = 'RESOLVED', resolved_at = SYSDATETIME(), resolved_note = ? WHERE id = ?`,
    [note, req.params.id]
  );
  res.redirect('/tickets');
});

// ---------- exports ----------

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
  // Per-entry usage = previous stock reading + this entry's issue - this entry's stock,
  // mirroring the derivation used elsewhere. Only defined for non-voided rows that carry a
  // stock reading; the prev-stock chain likewise ignores voided entries and rows with no stock.
  // The stock_readings CTE spans the full history (unfiltered) so prev_stock stays correct even
  // when a date range is selected; the user's filters are applied only to the outer result set.
  const { clause, params } = buildTransactionFilter(req.query);
  const transactions = await db.all(
    `WITH stock_readings AS (
       SELECT id, current_stock,
              LAG(current_stock) OVER (PARTITION BY material_id ORDER BY entry_date, id) AS prev_stock
       FROM issue_entries
       WHERE voided = 0 AND current_stock IS NOT NULL
     )
     SELECT e.*, m.prod_material_code, m.name AS material_name, m.workshop AS material_workshop,
            CASE WHEN e.voided = 0 AND e.current_stock IS NOT NULL
                 THEN COALESCE(sr.prev_stock, e.current_stock) + COALESCE(e.issue_qty, 0) - e.current_stock
                 ELSE NULL END AS usage
     FROM issue_entries e
     JOIN materials m ON m.id = e.material_id
     LEFT JOIN stock_readings sr ON sr.id = e.id
     WHERE 1=1${clause}
     ORDER BY e.entry_date DESC, e.id DESC`,
    params
  );

  const lines = ['Date,MaterialCode,MaterialName,Workshop,CurrentStock,Issue,Usage,IssueNCN,ReturnNCN,EmployeeId,Shift,Voided,VoidedReason'];
  for (const t of transactions) {
    lines.push(
      [
        fmtDateOnly(t.entry_date),
        t.prod_material_code,
        t.material_name,
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
