// One-off correction: move issue_entries.entry_date from '2026-08-07' to '2026-08-06'.
// Rows already dated '2026-08-06' are left untouched.
// Usage: node scripts/move-entry-date-07-to-06.js [--dry-run]
const db = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');
const FROM_DATE = '2026-08-07';
const TO_DATE = '2026-08-06';

async function main() {
  await db.ensureSchema();

  const affected = await db.all(
    `SELECT id, material_id, entry_date, current_stock, issue_qty, issue_ncn, return_ncn, employee_id, shift, voided
     FROM issue_entries WHERE entry_date = ? AND voided = 0 ORDER BY material_id, id`,
    [FROM_DATE]
  );
  console.log(`Rows with entry_date = ${FROM_DATE}: ${affected.length}`);
  affected.forEach((r) => {
    console.log(`  id=${r.id} material_id=${r.material_id} stock=${r.current_stock} issue=${r.issue_qty} ncn=${r.issue_ncn}/${r.return_ncn} emp=${r.employee_id} shift=${r.shift} voided=${r.voided}`);
  });

  if (!DRY_RUN && affected.length) {
    await db.run('UPDATE issue_entries SET entry_date = ? WHERE entry_date = ? AND voided = 0', [TO_DATE, FROM_DATE]);
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'}: ${affected.length} row(s) -> entry_date = ${TO_DATE}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
