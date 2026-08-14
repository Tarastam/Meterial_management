require('dotenv').config();
const db = require('../src/db');

async function testConnection(label, client) {
  try {
    const pool = await client.getPool();
    const result = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS db');
    console.log(`[${label}] Connected. Database: ${result.recordset[0].db}`);
    console.log(`[${label}] Server version: ${result.recordset[0].version.split('\n')[0]}`);
    return true;
  } catch (err) {
    console.error(`[${label}] Connection failed:`, err.message);
    return false;
  }
}

(async () => {
  const okPrimary = await testConnection(`TaMFGdb (${process.env.DB_SERVER})`, db);
  const okMes = await testConnection(`ProductionMES (${process.env.DB2_SERVER || process.env.DB_SERVER})`, db.mes);
  process.exit(okPrimary && okMes ? 0 : 1);
})();
