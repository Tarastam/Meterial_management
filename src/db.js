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
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('materials') AND name = 'std_consumption')
    BEGIN
      ALTER TABLE materials ADD std_consumption FLOAT NOT NULL DEFAULT 0
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

  // A material maps to one or more MES Operations (most materials need just one, but some
  // are genuinely produced across multiple workshops/operations, e.g. UV mark spanning both
  // FPSA and PSLA). Series (and their Part Numbers) are chosen underneath each Operation row
  // in material_process_series below.
  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_map')
    BEGIN
      CREATE TABLE material_process_map (
        id INT IDENTITY(1,1) PRIMARY KEY,
        material_id INT NOT NULL REFERENCES materials(id),
        operation_name NVARCHAR(200) NOT NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_material_process_map UNIQUE (material_id, operation_name)
      )
    END
  `);

  // Older installs stored (material, operation, serie) as one row per serie, with
  // part_number as a spare unused column. Migrate any such rows into the new
  // material_id-per-row shape (keeping just the operation) before the schema below
  // takes over series as their own table.
  await exec(`
    IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('material_process_map') AND name = 'serie')
    BEGIN
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_map_legacy')
        EXEC sp_rename 'material_process_map', 'material_process_map_legacy';
    END
  `);
  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_map')
    BEGIN
      CREATE TABLE material_process_map (
        id INT IDENTITY(1,1) PRIMARY KEY,
        material_id INT NOT NULL REFERENCES materials(id),
        operation_name NVARCHAR(200) NOT NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_material_process_map UNIQUE (material_id, operation_name)
      )
    END
  `);
  await exec(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_map_legacy')
    BEGIN
      INSERT INTO material_process_map (material_id, operation_name, updated_at)
      SELECT material_id, MIN(operation_name), MAX(updated_at)
      FROM material_process_map_legacy
      WHERE material_id NOT IN (SELECT material_id FROM material_process_map)
      GROUP BY material_id
    END
  `);

  // A material can now map to more than one Operation (e.g. its consumption is genuinely
  // produced across two workshops), so drop the old "one Operation per material" UNIQUE
  // constraint on installs created before this changed, and replace it with a
  // (material_id, operation_name) UNIQUE so the same pair can't be inserted twice. SQL
  // Server auto-names inline UNIQUE constraints, so look the old one up by column rather
  // than by a fixed name.
  await exec(`
    DECLARE @c NVARCHAR(200) = (
      SELECT kc.name
      FROM sys.key_constraints kc
      JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
      JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
      WHERE kc.type = 'UQ' AND kc.parent_object_id = OBJECT_ID('material_process_map')
        AND col.name = 'material_id'
        AND ic.index_column_id = 1
        AND (SELECT COUNT(*) FROM sys.index_columns ic2 WHERE ic2.object_id = ic.object_id AND ic2.index_id = ic.index_id) = 1
    );
    IF @c IS NOT NULL EXEC('ALTER TABLE material_process_map DROP CONSTRAINT ' + @c);
  `);
  await exec(`
    IF NOT EXISTS (
      SELECT * FROM sys.key_constraints WHERE name = 'UQ_material_process_map' AND parent_object_id = OBJECT_ID('material_process_map')
    )
    BEGIN
      ALTER TABLE material_process_map ADD CONSTRAINT UQ_material_process_map UNIQUE (material_id, operation_name)
    END
  `);

  // Series chosen for a material under its mapped Operation - a material can run multiple
  // series of the same operation.
  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_series')
    BEGIN
      CREATE TABLE material_process_series (
        id INT IDENTITY(1,1) PRIMARY KEY,
        material_process_map_id INT NOT NULL REFERENCES material_process_map(id) ON DELETE CASCADE,
        serie NVARCHAR(200) NOT NULL,
        created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_material_process_series UNIQUE (material_process_map_id, serie)
      )
    END
  `);
  await exec(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_map_legacy')
    BEGIN
      INSERT INTO material_process_series (material_process_map_id, serie)
      SELECT pm.id, legacy.serie
      FROM material_process_map_legacy legacy
      JOIN material_process_map pm ON pm.material_id = legacy.material_id
      WHERE NOT EXISTS (
        SELECT 1 FROM material_process_series ps WHERE ps.material_process_map_id = pm.id AND ps.serie = legacy.serie
      )
    END
  `);
  await exec(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_map_legacy')
      DROP TABLE material_process_map_legacy
  `);

  // Master list of Part Numbers that run under a given serie, populated by admin data
  // entry - independent of any material, since the same serie can be shared by several
  // materials run under different Part Numbers.
  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'serie_part_numbers')
    BEGIN
      CREATE TABLE serie_part_numbers (
        id INT IDENTITY(1,1) PRIMARY KEY,
        serie NVARCHAR(200) NOT NULL,
        part_number NVARCHAR(200) NOT NULL,
        created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_serie_part_numbers UNIQUE (serie, part_number)
      )
    END
  `);

  // Which of the serie's Part Numbers apply to a specific material-serie link. No rows
  // for a given material_process_series_id means "all Part Numbers of this serie" (the
  // default, since most materials don't need to be restricted to a subset).
  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'material_process_series_part_numbers')
    BEGIN
      CREATE TABLE material_process_series_part_numbers (
        id INT IDENTITY(1,1) PRIMARY KEY,
        material_process_series_id INT NOT NULL REFERENCES material_process_series(id) ON DELETE CASCADE,
        part_number NVARCHAR(200) NOT NULL,
        CONSTRAINT UQ_series_part_numbers UNIQUE (material_process_series_id, part_number)
      )
    END
  `);

  // Which Workshop each MES Serie belongs to - independent of any material, used to
  // filter the Serie list on the Material<->Serie tab down to one Workshop's series.
  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'serie_workshop_map')
    BEGIN
      CREATE TABLE serie_workshop_map (
        id INT IDENTITY(1,1) PRIMARY KEY,
        serie NVARCHAR(200) NOT NULL UNIQUE,
        workshop NVARCHAR(100) NOT NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
      )
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'users')
    BEGIN
      CREATE TABLE users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        username NVARCHAR(100) NOT NULL UNIQUE,
        password_hash NVARCHAR(200) NOT NULL,
        is_master BIT NOT NULL DEFAULT 0,
        permissions NVARCHAR(MAX) NOT NULL DEFAULT '[]',
        created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
      )
    END
  `);

  await exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('users') AND name = 'expires_at')
    BEGIN
      ALTER TABLE users ADD expires_at DATETIME2 NULL
    END
  `);
}

module.exports = { all, get, run, exec, ensureSchema, getPool, mes };
