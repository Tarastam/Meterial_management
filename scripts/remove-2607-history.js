require('dotenv').config();
const sql = require('mssql');
const db = require('../src/db');

const START_DATE = '2026-06-30';
const END_DATE = '2026-07-22';
const EXPECTED_ROW_COUNT = 4388;
const isConfirmed = process.argv.includes('--confirm');

function createRequest(connection) {
  return connection
    .request()
    .input('startDate', sql.Date, START_DATE)
    .input('endDate', sql.Date, END_DATE);
}

async function main() {
  const pool = await db.getPool();
  const countResult = await createRequest(pool).query(
    `SELECT COUNT(*) AS row_count
     FROM issue_entries
     WHERE employee_id = 'admin' AND entry_date >= @startDate AND entry_date < @endDate`
  );
  const rowCount = countResult.recordset[0].row_count;
  console.log(`Matching historical rows: ${rowCount}`);

  if (rowCount !== EXPECTED_ROW_COUNT) {
    throw new Error(`Refusing deletion: expected ${EXPECTED_ROW_COUNT} rows, found ${rowCount}.`);
  }
  if (!isConfirmed) {
    console.log('Preview only. Run with --confirm to delete these rows.');
    return;
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const deleteResult = await createRequest(transaction).query(
      `DELETE FROM issue_entries
       WHERE employee_id = 'admin' AND entry_date >= @startDate AND entry_date < @endDate;
       SELECT @@ROWCOUNT AS deleted_count;`
    );
    const deletedCount = deleteResult.recordset[0].deleted_count;
    if (deletedCount !== EXPECTED_ROW_COUNT) {
      throw new Error(`Deletion mismatch: expected ${EXPECTED_ROW_COUNT} rows, deleted ${deletedCount}.`);
    }
    await transaction.commit();
    console.log(`Deleted ${deletedCount} imported historical rows.`);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Historical cleanup failed: ${error.message}`);
  process.exit(1);
});
