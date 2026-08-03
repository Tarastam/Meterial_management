// One-time seed script: loads Material_List_seed.csv into the database.
// Safe to re-run - rows whose prod_material_code already exists are skipped.
// Usage (from project root): npm run import
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');

const CSV_PATH = path.join(__dirname, '..', 'Material_List_seed.csv');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`File not found: ${CSV_PATH}`);
    process.exit(1);
  }

  await db.ensureSchema();

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  const [header, ...dataRows] = rows;

  const existing = new Set(
    (await db.all('SELECT prod_material_code FROM materials')).map((r) => r.prod_material_code)
  );

  let imported = 0;
  let skipped = 0;

  for (const row of dataRows) {
    const [prodCode, materialCode, name, unit, workshop] = row;
    if (!prodCode || !name) {
      skipped++;
      continue;
    }
    if (existing.has(prodCode)) {
      skipped++;
      continue;
    }
    await db.run(
      `INSERT INTO materials (prod_material_code, material_code, name, unit, workshop, min_stock)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [prodCode.trim(), (materialCode || '').trim(), name.trim(), (unit || '').trim(), (workshop || '').trim()]
    );
    existing.add(prodCode);
    imported++;
  }

  console.log(`Imported ${imported} materials, skipped ${skipped} (already existed or blank).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
