// Repairs a bug introduced by scripts/shift-entry-date-08-10-back-1day.js: that script
// re-queried entry_date after each UPDATE, so rows that had already moved got caught by
// the next pair's WHERE clause and shifted again. Net effect: all 428 affected rows ended
// up on 2026-08-07 instead of being spread across 07/08/09.
//
// created_at was never touched, and it still cleanly identifies each row's original
// entry_date (verified: created_at's UTC calendar date == the row's original entry_date
// for every one of these rows, since each workshop keys one batch per day with created_at
// timestamps all falling on that same original day). Repair:
//   created_at UTC date 2026-08-08 -> entry_date stays 2026-08-07 (already correct)
//   created_at UTC date 2026-08-09 -> entry_date should be 2026-08-08
//   created_at UTC date 2026-08-10 -> entry_date should be 2026-08-09
//
// Defaults to a dry run. Pass --apply to write.
const db = require('../src/db');

const APPLY = process.argv.includes('--apply');
const EXCLUDED_WORKSHOPS = ['ANODIZE', 'POLYMER'];

const CORRECTIONS = [
  ['2026-08-09', '2026-08-08'],
  ['2026-08-10', '2026-08-09'],
];

async function main() {
  await db.ensureSchema();

  const rows = await db.all(
    `SELECT e.id, e.material_id, e.entry_date, e.created_at, m.workshop
     FROM issue_entries e JOIN materials m ON m.id = e.material_id
     WHERE e.voided = 0 AND e.entry_date = '2026-08-07'
       AND m.workshop NOT IN ('${EXCLUDED_WORKSHOPS.join("','")}')`
  );

  let totalFixed = 0;
  for (const [createdDate, correctEntryDate] of CORRECTIONS) {
    const toFix = rows.filter((r) => r.created_at.toISOString().slice(0, 10) === createdDate);
    const byWorkshop = {};
    toFix.forEach((r) => { byWorkshop[r.workshop] = (byWorkshop[r.workshop] || 0) + 1; });
    console.log(`\ncreated_at ${createdDate} -> entry_date ${correctEntryDate}: ${toFix.length} row(s)`);
    Object.entries(byWorkshop).forEach(([ws, cnt]) => console.log(`  ${ws}: ${cnt}`));

    if (APPLY) {
      for (const r of toFix) {
        await db.run('UPDATE issue_entries SET entry_date = ? WHERE id = ?', [correctEntryDate, r.id]);
      }
    }
    totalFixed += toFix.length;
  }

  const stayAt07 = rows.filter((r) => r.created_at.toISOString().slice(0, 10) === '2026-08-08');
  console.log(`\ncreated_at 2026-08-08 -> entry_date 2026-08-07 (no change needed): ${stayAt07.length} row(s)`);

  const unexpected = rows.filter((r) => !['2026-08-08', '2026-08-09', '2026-08-10'].includes(r.created_at.toISOString().slice(0, 10)));
  if (unexpected.length) {
    console.log(`\nWARNING: ${unexpected.length} row(s) at entry_date=2026-08-07 have unexpected created_at dates:`);
    unexpected.forEach((r) => console.log(`  id=${r.id} workshop=${r.workshop} created_at=${r.created_at.toISOString()}`));
  }

  console.log(`\n${APPLY ? 'Fixed' : '[DRY RUN] Would fix'}: ${totalFixed} row(s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Repair failed:', err);
  process.exit(1);
});
