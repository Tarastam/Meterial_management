// One-off correction: move issue_entries.entry_date from '2026-08-07' to '2026-08-06'
// for a given workshop only. Rows already dated '2026-08-06' are left untouched.
// Usage: node scripts/move-entry-date-07-to-06.js [--dry-run] [--workshop=FPSA]
const db = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');
const WORKSHOP_ARG = process.argv.find((a) => a.startsWith('--workshop='));
const WORKSHOP = WORKSHOP_ARG ? WORKSHOP_ARG.split('=')[1] : null;
const FROM_DATE = '2026-08-07';
const TO_DATE = '2026-08-06';

async function main() {
  await db.ensureSchema();

  const workshopClause = WORKSHOP ? 'AND m.workshop = ?' : '';
  const params = WORKSHOP ? [FROM_DATE, WORKSHOP] : [FROM_DATE];

  const affected = await db.all(
    `SELECT e.id, e.material_id, m.prod_material_code, m.workshop, e.entry_date, e.current_stock, e.issue_qty, e.issue_ncn, e.return_ncn, e.employee_id, e.shift, e.voided
     FROM issue_entries e JOIN materials m ON m.id = e.material_id
     WHERE e.entry_date = ? AND e.voided = 0 ${workshopClause} ORDER BY e.material_id, e.id`,
    params
  );
  console.log(`Rows with entry_date = ${FROM_DATE}${WORKSHOP ? ` (workshop=${WORKSHOP})` : ''}: ${affected.length}`);
  affected.forEach((r) => {
    console.log(`  id=${r.id} material_id=${r.material_id} code=${r.prod_material_code} workshop=${r.workshop} stock=${r.current_stock} issue=${r.issue_qty} ncn=${r.issue_ncn}/${r.return_ncn} emp=${r.employee_id} shift=${r.shift} voided=${r.voided}`);
  });

  if (!DRY_RUN && affected.length) {
    const ids = affected.map((r) => r.id);
    for (const id of ids) {
      await db.run('UPDATE issue_entries SET entry_date = ? WHERE id = ?', [TO_DATE, id]);
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'}: ${affected.length} row(s) -> entry_date = ${TO_DATE}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
