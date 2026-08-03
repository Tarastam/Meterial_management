// Syncs the Cost column from Material_List.xlsx (Sheet1 / Table1) into materials.cost.
// Matches rows by prod_material_code. Safe to re-run any time the xlsx cost values change.
// Usage: node scripts/update-material-cost.js [--dry-run]
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const db = require('../src/db');

const XLSX_PATH = path.join(__dirname, '..', 'Material_List.xlsx');
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`File not found: ${XLSX_PATH}`);
    process.exit(1);
  }

  await db.ensureSchema();

  const workbook = XLSX.readFile(XLSX_PATH);
  const sheet = workbook.Sheets['Sheet1'];
  if (!sheet) {
    console.error(`Sheet "Sheet1" not found in ${XLSX_PATH}`);
    process.exit(1);
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const materials = await db.all('SELECT id, prod_material_code FROM materials');
  const codeToId = new Map(materials.map((m) => [m.prod_material_code.trim().toUpperCase(), m.id]));

  let updated = 0;
  let skippedBlankCode = 0;
  let skippedUnmatched = 0;
  let skippedBadCost = 0;
  const unmatchedCodes = new Set();

  for (const row of rows) {
    const prodCode = String(row.ProdMaterialCode || '').trim();
    if (!prodCode) {
      skippedBlankCode++;
      continue;
    }

    const materialId = codeToId.get(prodCode.toUpperCase());
    if (!materialId) {
      skippedUnmatched++;
      unmatchedCodes.add(prodCode);
      continue;
    }

    const costRaw = row.Cost;
    const cost = costRaw === '' || costRaw == null ? null : Number(costRaw);
    if (cost !== null && Number.isNaN(cost)) {
      skippedBadCost++;
      continue;
    }

    if (!DRY_RUN) {
      await db.run('UPDATE materials SET cost = ? WHERE id = ?', [cost, materialId]);
    }
    updated++;
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Updated: ${updated}`);
  console.log(`Skipped (blank ProdMaterialCode): ${skippedBlankCode}`);
  console.log(`Skipped (code not found in materials): ${skippedUnmatched}`);
  if (unmatchedCodes.size) console.log(`  Unmatched codes: ${[...unmatchedCodes].join(', ')}`);
  console.log(`Skipped (non-numeric cost): ${skippedBadCost}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
