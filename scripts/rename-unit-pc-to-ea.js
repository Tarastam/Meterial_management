// One-off migration: rename material unit 'PC' -> 'EA' in the materials table.
// Usage: node scripts/rename-unit-pc-to-ea.js [--dry-run]
const db = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await db.ensureSchema();

  const affected = await db.all("SELECT id, prod_material_code, name FROM materials WHERE unit = 'PC'");
  console.log(`Rows with unit 'PC': ${affected.length}`);

  if (!DRY_RUN && affected.length) {
    await db.run("UPDATE materials SET unit = 'EA' WHERE unit = 'PC'");
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'}: ${affected.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
