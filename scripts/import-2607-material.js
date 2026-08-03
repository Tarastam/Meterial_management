// One-time historical import: loads 2607Material.csv (daily Issue/Remain log) into issue_entries.
// - employee_id is set to 'admin' for every row (per user instruction).
// - For the earliest date in the file (6/30/2026), issue_qty is overridden to equal Remain
//   (instead of the CSV's real Issue value) so the seed day nets to zero usage instead of
//   going negative from a nonexistent prior-day stock baseline.
// - Rows with a blank/unmatched ProdMaterialCode are skipped and reported.
// Usage: node scripts/import-2607-material.js [--dry-run]
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');

const CSV_PATH = path.join(__dirname, '..', '2607Material.csv');
const DRY_RUN = process.argv.includes('--dry-run');

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

function toIsoDate(mdy) {
  const [m, d, y] = mdy.trim().split('/').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`File not found: ${CSV_PATH}`);
    process.exit(1);
  }

  await db.ensureSchema();

  const text = fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(text);
  const [, ...dataRows] = rows;

  // Determine the earliest date in the file.
  let minDate = null;
  for (const row of dataRows) {
    const iso = toIsoDate(row[0]);
    if (!minDate || iso < minDate) minDate = iso;
  }
  console.log(`Earliest date in file: ${minDate} (issue_qty will be overridden to Remain for this date)`);

  const materials = await db.all('SELECT id, prod_material_code FROM materials');
  const codeToId = new Map(materials.map((m) => [m.prod_material_code.trim().toUpperCase(), m.id]));

  let inserted = 0;
  let skippedBlankCode = 0;
  let skippedUnmatched = 0;
  let skippedBadRow = 0;
  const unmatchedCodes = new Set();

  for (const row of dataRows) {
    const [dateRaw, prodCodeRaw, , , , workshopRaw, shiftRaw, issueRaw, remainRaw] = row;
    const prodCode = (prodCodeRaw || '').trim();

    if (!prodCode) {
      skippedBlankCode++;
      continue;
    }
    const materialId = codeToId.get(prodCode.toUpperCase());
    if (!materialId) {
      skippedUnmatched++;
      unmatchedCodes.add(prodCode);
      continue;
    }

    const entryDate = toIsoDate(dateRaw);
    const shift = (shiftRaw || '').trim().toUpperCase();
    if (!['A', 'B', 'C'].includes(shift)) {
      skippedBadRow++;
      continue;
    }

    const remain = remainRaw === '' || remainRaw == null ? null : parseFloat(remainRaw);
    const issueCsv = issueRaw === '' || issueRaw == null ? null : parseFloat(issueRaw);
    if (remain === null || Number.isNaN(remain)) {
      skippedBadRow++;
      continue;
    }

    const isSeedDay = entryDate === minDate;
    const issueQty = isSeedDay ? remain : issueCsv;

    if (!DRY_RUN) {
      await db.run(
        `INSERT INTO issue_entries (material_id, entry_date, current_stock, issue_qty, issue_ncn, return_ncn, employee_id, shift)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [materialId, entryDate, remain, issueQty, null, null, 'admin', shift]
      );
    }
    inserted++;
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Inserted: ${inserted}`);
  console.log(`Skipped (blank ProdMaterialCode): ${skippedBlankCode}`);
  console.log(`Skipped (code not found in materials): ${skippedUnmatched}`);
  if (unmatchedCodes.size) console.log(`  Unmatched codes: ${[...unmatchedCodes].join(', ')}`);
  console.log(`Skipped (bad row - invalid shift/remain): ${skippedBadRow}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
