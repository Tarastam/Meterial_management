require('dotenv').config();
const sql = require('mssql');

const primaryConfig = {
  server: process.env.DB_SERVER,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    instanceName: process.env.DB_INSTANCE || undefined,
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true',
    encrypt: process.env.DB_ENCRYPT !== 'false',
  },
};

// Production MES database — same server/password as above unless overridden.
const mesConfig = {
  server: process.env.DB2_SERVER || process.env.DB_SERVER,
  port: process.env.DB2_PORT
    ? Number(process.env.DB2_PORT)
    : (process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined),
  database: process.env.DB2_NAME,
  user: process.env.DB2_USER,
  password: process.env.DB2_PASSWORD || process.env.DB_PASSWORD,
  options: {
    instanceName: process.env.DB2_INSTANCE || process.env.DB_INSTANCE || undefined,
    trustServerCertificate: (process.env.DB2_TRUST_SERVER_CERT || process.env.DB_TRUST_SERVER_CERT) !== 'false',
    encrypt: true,
  },
};

function inferType(value) {
  if (value === null || value === undefined) return sql.NVarChar(sql.MAX);
  if (typeof value === 'number') return sql.Float;
  if (typeof value === 'boolean') return sql.Bit;
  if (value instanceof Date) return sql.DateTime2;
  return sql.NVarChar(sql.MAX);
}

// Converts positional `?` placeholders (SQLite-style) to named @p0, @p1, ... for mssql.
function toNamedParams(sqlText) {
  let i = 0;
  return sqlText.replace(/\?/g, () => `@p${i++}`);
}

// Each database gets its own ConnectionPool instance (not the mssql global
// pool via sql.connect), so the two connections don't clobber each other.
function createDbClient(config) {
  let poolPromise = null;
  function getPool() {
    if (!poolPromise) poolPromise = new sql.ConnectionPool(config).connect();
    return poolPromise;
  }

  async function request(params) {
    const pool = await getPool();
    const req = pool.request();
    params.forEach((value, i) => {
      req.input(`p${i}`, inferType(value), value === undefined ? null : value);
    });
    return req;
  }

  async function all(sqlText, params = []) {
    const req = await request(params);
    const result = await req.query(toNamedParams(sqlText));
    return result.recordset;
  }

  async function get(sqlText, params = []) {
    const rows = await all(sqlText, params);
    return rows[0];
  }

  async function run(sqlText, params = []) {
    const req = await request(params);
    await req.query(toNamedParams(sqlText));
  }

  async function exec(sqlText) {
    const pool = await getPool();
    await pool.request().query(sqlText);
  }

  return { all, get, run, exec, getPool };
}

const primary = createDbClient(primaryConfig);
const mes = createDbClient(mesConfig);
const { all, get, run, exec, getPool } = primary;

async function ensureSchema() {
  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'materials')
    BEGIN
      CREATE TABLE materials (
        id INT IDENTITY(1,1) PRIMARY KEY,
        prod_material_code NVARCHAR(100) NOT NULL UNIQUE,
        material_code NVARCHAR(100) NOT NULL DEFAULT '',
        name NVARCHAR(255) NOT NULL,
        unit NVARCHAR(50) NOT NULL,
        workshop NVARCHAR(100) NOT NULL,
        min_stock FLOAT NOT NULL DEFAULT 0,
        created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
      )
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('materials') AND name = 'cost')
    BEGIN
      ALTER TABLE materials ADD cost FLOAT NULL
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('materials') AND name = 'decimal_places')
    BEGIN
      ALTER TABLE materials ADD decimal_places INT NOT NULL DEFAULT 3
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'issue_entries')
    BEGIN
      CREATE TABLE issue_entries (
        id INT IDENTITY(1,1) PRIMARY KEY,
        material_id INT NOT NULL REFERENCES materials(id),
        entry_date DATE NOT NULL,
        current_stock FLOAT NULL,
        issue_qty FLOAT NULL,
        issue_ncn FLOAT NULL,
        return_ncn FLOAT NULL,
        employee_id NVARCHAR(20) NOT NULL,
        shift NVARCHAR(1) NOT NULL CHECK(shift IN ('A','B','C')),
        created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        voided BIT NOT NULL DEFAULT 0,
        voided_reason NVARCHAR(MAX) NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_issue_entries_material_date ON issue_entries(material_id, entry_date);
    END
  `);

  // Supports active stock history and usage calculations without repeatedly sorting
  // the entire issue log by material and date.
  await exec(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE object_id = OBJECT_ID(N'issue_entries')
        AND name = N'IX_issue_entries_active_material_date_id'
    )
    BEGIN
      CREATE INDEX IX_issue_entries_active_material_date_id
      ON issue_entries (material_id, entry_date, id)
      INCLUDE (current_stock, issue_qty, issue_ncn, return_ncn)
      WHERE voided = 0
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'tickets')
    BEGIN
      CREATE TABLE tickets (
        id INT IDENTITY(1,1) PRIMARY KEY,
        emp_no NVARCHAR(20) NOT NULL,
        full_name NVARCHAR(255) NOT NULL,
        shift NVARCHAR(1) NOT NULL CHECK(shift IN ('A','B','C')),
        workshop NVARCHAR(100) NOT NULL,
        detail NVARCHAR(MAX) NOT NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
        created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        resolved_at DATETIME2 NULL,
        resolved_note NVARCHAR(MAX) NOT NULL DEFAULT ''
      )
    END
  `);

  await exec(`
    IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tickets') AND name = 'full_name' AND is_nullable = 0)
    BEGIN
      ALTER TABLE tickets ALTER COLUMN full_name NVARCHAR(255) NULL
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tickets') AND name = 'attachment_path')
    BEGIN
      ALTER TABLE tickets ADD attachment_path NVARCHAR(500) NULL
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tickets') AND name = 'attachment_name')
    BEGIN
      ALTER TABLE tickets ADD attachment_name NVARCHAR(255) NULL
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tickets') AND name = 'type')
    BEGIN
      ALTER TABLE tickets ADD type NVARCHAR(20) NOT NULL DEFAULT 'MANUAL' CHECK(type IN ('MANUAL','CHANGE','CREATE'))
    END
  `);
}

module.exports = { all, get, run, exec, ensureSchema, getPool, mes };
