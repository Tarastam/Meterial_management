// One-off migration: repair ticket attachment_name values mangled by the multer
// latin1/utf8 filename bug (fixed in server.js). Re-interpreting the stored bytes
// recovers the original UTF-8 name; pure-ASCII names round-trip unchanged, so this
// is safe to run against every row.
// Usage: node scripts/fix-mojibake-attachment-names.js [--dry-run]
const db = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

function fixMojibake(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

async function main() {
  await db.ensureSchema();

  const rows = await db.all("SELECT id, attachment_name FROM tickets WHERE attachment_name IS NOT NULL");
  const changed = rows
    .map((row) => ({ ...row, fixed: fixMojibake(row.attachment_name) }))
    .filter((row) => row.fixed !== row.attachment_name);

  console.log(`Rows with attachment_name: ${rows.length}, mangled: ${changed.length}`);
  for (const row of changed) {
    console.log(`  #${row.id}: ${JSON.stringify(row.attachment_name)} -> ${JSON.stringify(row.fixed)}`);
    if (!DRY_RUN) {
      await db.run('UPDATE tickets SET attachment_name = ? WHERE id = ?', [row.fixed, row.id]);
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'}: ${changed.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
