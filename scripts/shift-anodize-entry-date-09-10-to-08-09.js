// One-off correction: move ANODIZE's issue_entries.entry_date from 08-09/08-10 back to
// 08-08/08-09. ANODIZE was excluded from the earlier 08-10-back-1day shift because it had
// a separate data gap (missing 08-07 and 08-08 entirely) that needed investigating first.
// That gap is confirmed empty (0 rows on both dates for ANODIZE), so the two pairs below
// can't collide with existing rows at their destination date.
//
// Both pairs are computed BEFORE any writes (this is what the earlier cascade-bug script
// got wrong: it re-queried by entry_date after each UPDATE, so already-moved rows got
// caught by the next pair's WHERE clause and shifted twice).
//
// Defaults to a dry run (lists affected rows, no writes). Pass --apply to write.
// Usage: node scripts/shift-anodize-entry-date-09-10-to-08-09.js [--apply]
const db = require('../src/db');

const APPLY = process.argv.includes('--apply');

const DATE_PAIRS = [
  ['2026-08-10', '2026-08-09'],
  ['2026-08-09', '2026-08-08'],
];

async function main() {
  await db.ensureSchema();

  const updates = [];

  for (const [FROM_DATE, TO_DATE] of DATE_PAIRS) {
    const affected = await db.all(
      `SELECT e.id, e.material_id, m.prod_material_code, e.entry_date, e.created_at,
              e.current_stock, e.issue_qty, e.issue_ncn, e.return_ncn, e.employee_id, e.shift, e.voided
       FROM issue_entries e JOIN materials m ON m.id = e.material_id
       WHERE e.entry_date = ? AND e.voided = 0 AND m.workshop = 'ANODIZE'
       ORDER BY e.material_id, e.id`,
      [FROM_DATE]
    );

    console.log(`\n${FROM_DATE} -> ${TO_DATE}: ${affected.length} row(s)`);
    affected.forEach((r) => {
      console.log(`  id=${r.id} material_id=${r.material_id} code=${r.prod_material_code} stock=${r.current_stock} issue=${r.issue_qty} ncn=${r.issue_ncn}/${r.return_ncn} emp=${r.employee_id} shift=${r.shift}`);
      updates.push({ id: r.id, to: TO_DATE });
    });
  }

  if (APPLY) {
    for (const { id, to } of updates) {
      await db.run('UPDATE issue_entries SET entry_date = ? WHERE id = ?', [to, id]);
    }
  }

  console.log(`\n${APPLY ? 'Updated' : '[DRY RUN] Would update'}: ${updates.length} row(s) total`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
