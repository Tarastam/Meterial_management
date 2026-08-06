require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const sql = require('mssql');
const db = require('../src/db');

const CSV_PATH = path.join(__dirname, '..', '2607Material.csv');
const START_DATE = '2026-06-30';
const END_DATE = '2026-07-22';
const isConfirmed = process.argv.includes('--confirm');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] !== '"') inQuotes = false;
      else if (character === '"') { field += character; index += 1; }
      else field += character;
    } else if (character === '"') inQuotes = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += character;
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
}

function toIsoDate(value) {
  const [month, day, year] = value.trim().split('/').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function numberKey(value) {
  return value === null || value === undefined ? '' : String(Number(value));
}

function rowKey(row) {
  return [row.materialId, row.entryDate, numberKey(row.currentStock), numberKey(row.issueQty), row.shift].join('|');
}

async function getImportedKeys(pool) {
  if (!fs.existsSync(CSV_PATH)) throw new Error(`Source CSV not found: ${CSV_PATH}`);
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8').replace(/^ï»¿/, ''));
  const [, ...dataRows] = rows;
  const dates = dataRows.map((row) => toIsoDate(row[0]));
  const seedDate = dates.reduce((earliest, value) => (!earliest || value < earliest ? value : earliest), null);
  const materials = await db.all('SELECT id, prod_material_code FROM materials');
  const materialIdByCode = new Map(materials.map((material) => [material.prod_material_code.trim().toUpperCase(), material.id]));
  const keys = new Set();

  for (const row of dataRows) {
    const [dateRaw, prodCodeRaw, , , , , shiftRaw, issueRaw, remainRaw] = row;
    const materialId = materialIdByCode.get((prodCodeRaw || '').trim().toUpperCase());
    const shift = (shiftRaw || '').trim().toUpperCase();
    const currentStock = remainRaw === '' || remainRaw == null ? null : Number(remainRaw);
    const entryDate = toIsoDate(dateRaw);
    if (!materialId || !['A', 'B', 'C'].includes(shift) || currentStock === null || Number.isNaN(currentStock)) continue;
    const issueQty = entryDate === seedDate ? currentStock : Number(issueRaw);
    if (Number.isNaN(issueQty)) continue;
    keys.add(rowKey({ materialId, entryDate, currentStock, issueQty, shift }));
  }
  return keys;
}

async function main() {
  const pool = await db.getPool();
  const importedKeys = await getImportedKeys(pool);
  const candidates = await pool.request()
    .input('startDate', sql.Date, START_DATE)
    .input('endDate', sql.Date, END_DATE)
    .query(`SELECT id, material_id, CONVERT(varchar(10), entry_date, 23) AS entry_date,
                   current_stock, issue_qty, issue_ncn, return_ncn, shift
            FROM issue_entries
            WHERE employee_id = 'admin' AND entry_date >= @startDate AND entry_date < @endDate`);
  const matchingIds = candidates.recordset
    .filter((row) => row.issue_ncn === null && row.return_ncn === null)
    .filter((row) => importedKeys.has(rowKey({
      materialId: row.material_id,
      entryDate: row.entry_date,
      currentStock: row.current_stock,
      issueQty: row.issue_qty,
      shift: row.shift,
    })))
    .map((row) => row.id);
  console.log(`Exact CSV-matching rows: ${matchingIds.length}`);
  if (!isConfirmed) {
    console.log('Preview only. Run with --confirm to delete these rows.');
    return;
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    let deletedCount = 0;
    for (let offset = 0; offset < matchingIds.length; offset += 500) {
      const request = new sql.Request(transaction);
      const ids = matchingIds.slice(offset, offset + 500);
      const parameters = ids.map((id, index) => {
        request.input(`id${index}`, sql.Int, id);
        return `@id${index}`;
      });
      const result = await request.query(`DELETE FROM issue_entries WHERE id IN (${parameters.join(', ')})`);
      deletedCount += result.rowsAffected[0];
    }
    await transaction.commit();
    console.log(`Deleted ${deletedCount} exact CSV-matching rows.`);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Historical cleanup failed: ${error.message}`);
  process.exit(1);
});
