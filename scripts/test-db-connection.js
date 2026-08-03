require('dotenv').config();
const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    instanceName: process.env.DB_INSTANCE || undefined,
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    encrypt: true,
  },
};

(async () => {
  console.log(`Connecting to ${config.server}${config.options.instanceName ? '\\' + config.options.instanceName : ''} / ${config.database} as ${config.user}...`);
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS db');
    console.log('Connected successfully.');
    console.log('Database:', result.recordset[0].db);
    console.log('Server version:', result.recordset[0].version.split('\n')[0]);
    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error('Connection failed:', err.message);
    process.exit(1);
  }
})();
