// One-off correction: set unit cost for TA0212 (XYLENES) to 0.250.
//
// Defaults to a dry run (shows current value, no writes). Pass --apply to write.
// Usage: node scripts/set-ta0212-cost.js [--apply]
const db = require('../src/db');

const APPLY = process.argv.includes('--apply');
const PROD_MATERIAL_CODE = 'TA0212';
const NEW_COST = 0.250;

async function main() {
  await db.ensureSchema();

  const material = await db.get('SELECT id, prod_material_code, name, cost FROM materials WHERE prod_material_code = ?', [PROD_MATERIAL_CODE]);
  if (!material) {
    console.error(`Material ${PROD_MATERIAL_CODE} not found`);
    process.exit(1);
  }

  console.log(`Material: ${material.prod_material_code} - ${material.name} (id=${material.id})`);
  console.log(`Cost: ${material.cost} -> ${NEW_COST}`);

  if (APPLY) {
    await db.run('UPDATE materials SET cost = ? WHERE id = ?', [NEW_COST, material.id]);
    console.log('Updated.');
  } else {
    console.log('[DRY RUN] No changes written. Re-run with --apply to update.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
