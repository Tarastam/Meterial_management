// One-off correction: for workshops that key their previous day's shift data sometime
// after the 07:00 Thai cutover (see entryDayStr() in server.js), issue_entries.entry_date
// ends up stamped as the keying day instead of the day the shift actually happened.
// This shifts entry_date back 1 day for 2026-08-08 -> 07, 08-09 -> 08, 08-10 -> 09.
//
// ANODIZE and POLYMER are excluded:
//   - POLYMER keys before the 07:00 cutover, so entryDayStr() already attributes it
//     to the correct prior business day.
//   - ANODIZE has a separate data gap (missing both 08-07 and 08-08 entirely) that
//     needs to be investigated on its own before any date correction is applied.
//
// Defaults to a dry run (lists affected rows, no writes). Pass --apply to write.
// Usage: node scripts/shift-entry-date-08-10-back-1day.js [--apply] [--workshop=FPSA]
const db = require('../src/db');

const APPLY = process.argv.includes('--apply');
const WORKSHOP_ARG = process.argv.find((a) => a.startsWith('--workshop='));
const ONLY_WORKSHOP = WORKSHOP_ARG ? WORKSHOP_ARG.split('=')[1] : null;

const EXCLUDED_WORKSHOPS = ['ANODIZE', 'POLYMER'];
const DATE_PAIRS = [
  ['2026-08-10', '2026-08-09'],
  ['2026-08-09', '2026-08-08'],
  ['2026-08-08', '2026-08-07'],
];

async function main() {
  await db.ensureSchema();

  let totalAffected = 0;

  for (const [FROM_DATE, TO_DATE] of DATE_PAIRS) {
    const workshopClause = ONLY_WORKSHOP ? 'AND m.workshop = ?' : '';
    const params = ONLY_WORKSHOP ? [FROM_DATE, ONLY_WORKSHOP] : [FROM_DATE];

    const affected = await db.all(
      `SELECT e.id, e.material_id, m.prod_material_code, m.workshop, e.entry_date, e.created_at,
              e.current_stock, e.issue_qty, e.issue_ncn, e.return_ncn, e.employee_id, e.shift, e.voided
       FROM issue_entries e JOIN materials m ON m.id = e.material_id
       WHERE e.entry_date = ? AND e.voided = 0
         AND m.workshop NOT IN ('${EXCLUDED_WORKSHOPS.join("','")}')
         ${workshopClause}
       ORDER BY m.workshop, e.material_id, e.id`,
      params
    );

    console.log(`\n${FROM_DATE} -> ${TO_DATE}: ${affected.length} row(s)${ONLY_WORKSHOP ? ` (workshop=${ONLY_WORKSHOP})` : ''}`);
    const byWorkshop = {};
    affected.forEach((r) => {
      byWorkshop[r.workshop] = (byWorkshop[r.workshop] || 0) + 1;
    });
    Object.entries(byWorkshop).forEach(([ws, cnt]) => console.log(`  ${ws}: ${cnt}`));

    if (APPLY && affected.length) {
      const ids = affected.map((r) => r.id);
      for (const id of ids) {
        await db.run('UPDATE issue_entries SET entry_date = ? WHERE id = ?', [TO_DATE, id]);
      }
    }

    totalAffected += affected.length;
  }

  console.log(`\n${APPLY ? 'Updated' : '[DRY RUN] Would update'}: ${totalAffected} row(s) total`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
