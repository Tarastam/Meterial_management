// Import: loads TransferDatabase.xlsx into dbo.issue_entries.
//
// Rules (per user instruction):
//   - 7/31 rows: Remain -> both current_stock and issue_qty (baseline day).
//   - All other rows: current_stock = Remain, issue_qty = Issue, as given in the file.
//   - employee_id = 'admin' (matches precedent from prior historical workshop imports).
//   - created_at backfilled from the file's OccurredOn column.
//   - Byte-identical repeated rows are collapsed. The export duplicates whole workshop
//     blocks (8/4: FPSA emitted 4x, FPSB 2x); since usage sums issue_qty but takes only the
//     last stock reading, leaving them in multiplies usage by the duplication factor.
//     Rows that share a material but differ in any value are kept -- a few materials
//     legitimately report two lines a day (e.g. 1401400022 in FPSA).
//
// Usage:
//   node scripts/import-transfer-database.js                          (dry run, all rows)
//   node scripts/import-transfer-database.js --date=2026-08-04         (dry run, one date only)
//   node scripts/import-transfer-database.js --date=2026-08-04 --commit (insert one date only)
const path = require('node:path');
const xlsx = require('xlsx');
const db = require('../src/db');

const XLSX_PATH = path.join(__dirname, '..', 'TransferDatabase.xlsx');
const BASELINE_DATE = '2026-07-31';
const dateArg = process.argv.find((a) => a.startsWith('--date='));
const ONLY_DATE = dateArg ? dateArg.slice('--date='.length) : null;

function parseOccurredOn(str) {
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable OccurredOn: ${str}`);
  const entryDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { createdAt: d, entryDate };
}

async function main() {
  const commit = process.argv.includes('--commit');

  const wb = xlsx.readFile(XLSX_PATH);
  const sheet = wb.Sheets['Sheet1'];
  const json = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  const rows = json.slice(1);

  const materials = await db.all('SELECT id, material_code, name, workshop FROM materials');
  const byCodeWs = new Map();
  for (const m of materials) {
    const key = m.material_code.trim() + '|' + m.workshop.trim().toLowerCase();
    if (!byCodeWs.has(key)) byCodeWs.set(key, []);
    byCodeWs.get(key).push(m);
  }

  const plan = [];
  const errors = [];
  const seenRows = new Set();
  let duplicatesSkipped = 0;

  for (const r of rows) {
    const [occurredOn, materialCode, materialName, issue, remain, , shift, workshop] = r;
    if (!occurredOn) continue;

    const { createdAt, entryDate } = parseOccurredOn(occurredOn);
    if (ONLY_DATE && entryDate !== ONLY_DATE) continue;

    const signature = r.map((v) => String(v).trim()).join('|');
    if (seenRows.has(signature)) {
      duplicatesSkipped++;
      continue;
    }
    seenRows.add(signature);
    const key = materialCode.trim() + '|' + workshop.trim().toLowerCase();
    const candidates = byCodeWs.get(key) || [];
    let material = candidates[0];
    if (candidates.length > 1) {
      material = candidates.find((m) => m.name.trim().toLowerCase() === materialName.trim().toLowerCase());
    }
    if (!material) {
      errors.push(`No material match for code=${materialCode} workshop=${workshop} name=${materialName}`);
      continue;
    }

    const remainNum = parseFloat(remain);
    const issueNum = parseFloat(issue);
    const issueQty = entryDate === BASELINE_DATE ? remainNum : issueNum;

    plan.push({
      materialId: material.id,
      entryDate,
      currentStock: remainNum,
      issueQty,
      shift,
      createdAt,
    });
  }

  if (errors.length) {
    console.error(`${errors.length} row(s) failed to match a material:`);
    errors.forEach((e) => console.error('  ' + e));
    process.exit(1);
  }

  const byDate = {};
  for (const p of plan) byDate[p.entryDate] = (byDate[p.entryDate] || 0) + 1;
  console.log(`Parsed ${plan.length} rows. By date:`, byDate);
  console.log(`Skipped ${duplicatesSkipped} byte-identical duplicate row(s) from the export.`);
  console.log('Sample:', JSON.stringify(plan.slice(0, 3), null, 1));

  if (!commit) {
    console.log('\nDry run only. Re-run with --commit to insert into issue_entries.');
    process.exit(0);
  }

  let inserted = 0;
  for (const p of plan) {
    await db.run(
      `INSERT INTO issue_entries (material_id, entry_date, current_stock, issue_qty, issue_ncn, return_ncn, employee_id, shift, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.materialId, p.entryDate, p.currentStock, p.issueQty, null, null, 'admin', p.shift, p.createdAt]
    );
    inserted++;
  }
  console.log(`Inserted ${inserted} rows into issue_entries.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
