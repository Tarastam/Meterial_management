// One-off correction: TA0168 (SILICONE COATING R6102) changed unit from kg to g,
// but its historical issue_entries rows still hold kg-scale values. Multiply
// current_stock, issue_qty, issue_ncn, return_ncn by 1000 for every transaction
// of this material (including voided rows, since they're still historical data).
//
// Defaults to a dry run (lists affected rows, no writes). Pass --apply to write.
// Usage: node scripts/multiply-ta0168-x1000.js [--apply]
const db = require('../src/db');

const APPLY = process.argv.includes('--apply');
const PROD_MATERIAL_CODE = 'TA0168';
const FACTOR = 1000;

async function main() {
  await db.ensureSchema();

  const material = await db.get('SELECT id, prod_material_code, unit FROM materials WHERE prod_material_code = ?', [PROD_MATERIAL_CODE]);
  if (!material) {
    console.error(`Material ${PROD_MATERIAL_CODE} not found`);
    process.exit(1);
  }

  const rows = await db.all(
    `SELECT id, entry_date, current_stock, issue_qty, issue_ncn, return_ncn, voided
     FROM issue_entries
     WHERE material_id = ?
     ORDER BY entry_date, id`,
    [material.id]
  );

  console.log(`Material: ${material.prod_material_code} (id=${material.id}, unit=${material.unit})`);
  console.log(`${rows.length} transaction(s) found\n`);

  rows.forEach((r) => {
    const mul = (v) => (v === null ? null : v * FACTOR);
    console.log(
      `  id=${r.id} date=${r.entry_date.toISOString().slice(0, 10)} voided=${r.voided}` +
      ` | stock ${r.current_stock} -> ${mul(r.current_stock)}` +
      ` | issue ${r.issue_qty} -> ${mul(r.issue_qty)}` +
      ` | issue_ncn ${r.issue_ncn} -> ${mul(r.issue_ncn)}` +
      ` | return_ncn ${r.return_ncn} -> ${mul(r.return_ncn)}`
    );
  });

  if (APPLY) {
    for (const r of rows) {
      await db.run(
        `UPDATE issue_entries
         SET current_stock = CASE WHEN current_stock IS NULL THEN NULL ELSE current_stock * ? END,
             issue_qty = CASE WHEN issue_qty IS NULL THEN NULL ELSE issue_qty * ? END,
             issue_ncn = CASE WHEN issue_ncn IS NULL THEN NULL ELSE issue_ncn * ? END,
             return_ncn = CASE WHEN return_ncn IS NULL THEN NULL ELSE return_ncn * ? END
         WHERE id = ?`,
        [FACTOR, FACTOR, FACTOR, FACTOR, r.id]
      );
    }
  }

  console.log(`\n${APPLY ? 'Updated' : '[DRY RUN] Would update'}: ${rows.length} row(s) total`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
