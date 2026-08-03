import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";
import { buildSlide02 } from "./layouts/slide-02.mjs";
import { buildSlide04 } from "./layouts/slide-04.mjs";
import { buildSlide05 } from "./layouts/slide-05.mjs";
import { buildSlide06 } from "./layouts/slide-06.mjs";
import { buildSlide10 } from "./layouts/slide-10.mjs";
import { buildSlide11 } from "./layouts/slide-11.mjs";
import { buildSlide17 } from "./layouts/slide-17.mjs";
import { buildSlide26 } from "./layouts/slide-26.mjs";

const ROOT = "C:/Users/2172172204501/OneDrive - YAGEO CORPORATION/Desktop/Project Management/Material_Management";
const ASSETS = `${ROOT}/.pptx_build/assets`;
const OUTPUT = `${ROOT}/Material_Management_User_Guide_EN.pptx`;
const RENDER_DIR = `${ROOT}/.pptx_build/rendered`;

const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

function rich(text, size = 18.67, bold = false, options = {}) {
  return {
    runs: [{
      run: text,
      textStyle: {
        fontSize: `${size}px`,
        typeface: "Helvetica Neue",
        color: options.color || "#000000",
        bold,
      },
    }],
    spaceAfter: options.spaceAfter ?? 650,
    paragraphStyle: { lineSpacingPercent: options.lineSpacingPercent || 112000 },
  };
}

function bullet(text, size = 18.67) {
  return {
    ...rich(text, size, false, { spaceAfter: 600 }),
    bulletCharacter: "•",
    marginLeft: 228600,
    indent: -228600,
  };
}

function title(text) {
  return rich(text, 38.67, false, { spaceAfter: 0, lineSpacingPercent: 90000 });
}

function notes(slide, sourceLines) {
  slide.speakerNotes.textFrame.setText(`[Sources]\n${sourceLines.map((s) => `- ${s}`).join("\n")}`);
  slide.speakerNotes.setVisible(true);
}

async function imageBytes(name) {
  const bytes = await fs.readFile(`${ASSETS}/${name}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function addScreenshot(slide, name, position, alt) {
  slide.images.add({
    blob: await imageBytes(name),
    contentType: "image/png",
    alt,
    fit: "cover",
    position,
    geometry: "roundRect",
    borderRadius: "rounded-lg",
  });
}

// 1 — Cover
{
  const slide = buildSlide02(presentation, {
    title: rich("MATERIAL MANAGEMENT", 24, true),
    title2: rich("ENGLISH USER GUIDE", 24, false),
    title3: {
      runs: [
        { run: "Material Management", textStyle: { fontSize: "80px", typeface: "Helvetica Neue", color: "#000000" } },
        { run: "\nUser Guide", textStyle: { fontSize: "80px", typeface: "Helvetica Neue", color: "#000000" } },
      ],
      paragraphStyle: { lineSpacingPercent: 90000 },
    },
  });
  notes(slide, ["Local Material Management application and project source code; accessed 2026-08-03."]);
}

// 2 — Navigation overview
{
  const slide = buildSlide05(presentation, {
    footer1: "2",
    title: title("The top navigation covers every daily task"),
    body1: { titleHere: rich("Application home", 21.33, true), loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Use the same navigation bar from any screen.", 18.67) },
    body2: {
      titleHere: rich("Choose the page that matches your task", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Dashboard - monitor trends\nSummary - review stock and usage\nRecord Data - enter daily values\nConsumption - calculate material per output\nTransactions - review history\nRequest Change - report an error", 18.67),
    },
  });
  await addScreenshot(slide, "dashboard.png", { left: 41.33, top: 213.33, width: 581.33, height: 326.99 }, "Material Management dashboard and top navigation");
  notes(slide, ["Screenshot: local app / (Dashboard), captured 2026-08-03."]);
}

// 3 — Dashboard
{
  const slide = buildSlide04(presentation, {
    footer1: "3",
    title: title("Use Dashboard filters before reading a trend"),
    body1: {
      titleHere: rich("Dashboard workflow", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: bullet("Search by material code or name."),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: bullet("Limit results by workshop, material, shift, and date range."),
      loremIpsumDolorSitAmetConsecteturAdipiscing3: bullet("Select Issue or Usage, then review month-over-month and cost sections."),
    },
    body2: {
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Dashboard screenshot", 18.67, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: rich("", 18.67),
      loremIpsumDolorSitAmetConsecteturAdipiscing3: rich("", 18.67),
    },
  });
  await addScreenshot(slide, "dashboard.png", { left: 657.75, top: 213.33, width: 581.33, height: 326.99 }, "Dashboard filters and trend area");
  notes(slide, ["Screenshot: local app / (Dashboard), captured 2026-08-03.", "Behavior verified in server.js dashboard routes."]);
}

// 4 — Summary
{
  const slide = buildSlide05(presentation, {
    footer1: "4",
    title: title("Summary turns stock records into a searchable list"),
    body1: { titleHere: rich("Summary screen", 21.33, true), loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Review material status without editing records.", 18.67) },
    body2: {
      titleHere: rich("How to use it", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("1. Search by code or name.\n2. Select a workshop and date range.\n3. Compare Issue, Usage, On Hand, and Hold.\n4. Use Export CSV when offline analysis is needed.", 18.67),
    },
  });
  await addScreenshot(slide, "materials.png", { left: 41.33, top: 213.33, width: 581.33, height: 326.99 }, "Summary table with material balances");
  notes(slide, ["Screenshot: local app /materials (Summary), captured 2026-08-03."]);
}

// 5 — Record Data
{
  const slide = buildSlide04(presentation, {
    footer1: "5",
    title: title("Record only the materials that changed today"),
    body1: {
      titleHere: rich("Before selecting Submit", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: bullet("Select the correct workshop first."),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: bullet("Enter values only on relevant material rows; leave unused rows blank."),
      loremIpsumDolorSitAmetConsecteturAdipiscing3: bullet("Confirm the 7-digit Employee ID and shift A, B, or C."),
    },
    body2: {
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Record Data screenshot", 18.67, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: rich("", 18.67),
      loremIpsumDolorSitAmetConsecteturAdipiscing3: rich("", 18.67),
    },
  });
  await addScreenshot(slide, "record-data.png", { left: 657.75, top: 213.33, width: 581.33, height: 326.99 }, "Record Data table for the GPS workshop");
  notes(slide, ["Screenshot: local app /issue?workshop=GPS (Record Data), captured 2026-08-03.", "Input rules verified in server.js issue route."]);
}

// 6 — Record workflow
{
  const slide = buildSlide17(presentation, {
    footer1: "6",
    title: title("Complete one daily entry in three checks"),
    label1: rich("CHECK 1", 18.67, true),
    label2: rich("CHECK 2", 18.67, true),
    label3: rich("CHECK 3", 18.67, true),
    body1: { titleHere: rich("Identify", 21.33, true), loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Confirm workshop, material code, ERP code, name, and unit.", 18.67) },
    body2: { titleHere: rich("Enter", 21.33, true), loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Record stock, issue, and NCN values. Use zero only when zero is the intended value.", 18.67) },
    body3: { titleHere: rich("Validate", 21.33, true), loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Recheck Employee ID and shift, then submit once and read any warning.", 18.67) },
  });
  notes(slide, ["Workflow derived from local app /issue and server-side validation in server.js."]);
}

// 7 — Field definitions
{
  const slide = buildSlide11(presentation, {
    footer1: "7",
    title: title("Each Record Data field has a different meaning"),
    body1: {
      topic: rich("Enter the physical value shown for the selected material and unit.", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Do not copy a number from another row. Blank means no value was recorded; zero means the value is actually zero.", 18.67),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: rich("", 18.67),
    },
    body2: rich("Stock and Issue", 21.33, true),
    body3: rich("NCN movements", 21.33, true),
    body4: {
      detailGoesHere: bullet("Current Stock: physical on-hand quantity."),
      detailGoesHere2: bullet("Issue: quantity issued in the period."),
      detailGoesHere3: bullet("Match the displayed unit before typing."),
    },
    body5: {
      detailGoesHere: bullet("Issue NCN: quantity moved to NCN."),
      detailGoesHere2: bullet("Return NCN: quantity returned from NCN."),
      detailGoesHere3: bullet("Never swap the two NCN columns."),
    },
  });
  notes(slide, ["Field names and usage derived from local app /issue and issue_entries schema in src/db.js."]);
}

// 8 — Consumption
{
  const slide = buildSlide05(presentation, {
    footer1: "8",
    title: title("Consumption connects material usage to product output"),
    body1: { titleHere: rich("Consumption calculator", 21.33, true), loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Consumption = Material Usage / Product Output", 18.67) },
    body2: {
      titleHere: rich("Calculation steps", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("1. Select a workshop and material.\n2. Set the From and To dates.\n3. Enter Product Output in kPcs when available.\n4. Select Calculate and review Usage and Consumption.\n\nProduct Output must be greater than zero.", 18.67),
    },
  });
  await addScreenshot(slide, "consumption.png", { left: 41.33, top: 213.33, width: 581.33, height: 326.99 }, "Consumption calculator fields");
  notes(slide, ["Screenshot: local app /consumption, captured 2026-08-03.", "Formula and validation verified in server.js consumption route."]);
}

// 9 — Transactions
{
  const slide = buildSlide04(presentation, {
    footer1: "9",
    title: title("Transactions is the audit trail for every entry"),
    body1: {
      titleHere: rich("Find the exact record", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: bullet("Filter by material, Employee ID, workshop, shift, and date."),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: bullet("Check stock, issue, NCN values, employee, and shift together."),
      loremIpsumDolorSitAmetConsecteturAdipiscing3: bullet("Use Export CSV for an approved report; use Request Change when a record is wrong."),
    },
    body2: {
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("Transactions screenshot", 18.67, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: rich("", 18.67),
      loremIpsumDolorSitAmetConsecteturAdipiscing3: rich("", 18.67),
    },
  });
  await addScreenshot(slide, "transactions.png", { left: 657.75, top: 213.33, width: 581.33, height: 326.99 }, "Transactions filters and audit table");
  notes(slide, ["Screenshot: local app /transactions, captured 2026-08-03."]);
}

// 10 — Request Change
{
  const slide = buildSlide05(presentation, {
    footer1: "10",
    title: title("Report an incorrect entry instead of entering it again"),
    body1: { titleHere: rich("Request a Data Change", 21.33, true), loremIpsumDolorSitAmetConsecteturAdipiscing: rich("A correction ticket keeps the issue traceable for an administrator.", 18.67) },
    body2: {
      titleHere: rich("Include enough detail", 21.33, true),
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("1. Enter employee number and full name.\n2. Select the correct shift and workshop.\n3. State the date, material code, wrong value, correct value, and reason.\n4. Submit one ticket and wait for review.", 18.67),
    },
  });
  await addScreenshot(slide, "request-change.png", { left: 41.33, top: 213.33, width: 581.33, height: 326.99 }, "Request a Data Change form");
  notes(slide, ["Screenshot: local app /tickets/new, captured 2026-08-03.", "Ticket fields verified in server.js ticket route."]);
}

// 11 — Checklist
{
  const slide = buildSlide10(presentation, {
    footer1: "11",
    title: title("Five checks prevent most entry errors"),
    body1: rich("Pause for ten seconds before selecting Submit. A quick visual check is faster than requesting a correction later.", 21.33, true),
    body2: {
      loremIpsumDolorSitAmetConsecteturAdipiscing: rich("If a warning appears after saving, read it immediately and compare the current stock and issue values with the source document.", 18.67),
      loremIpsumDolorSitAmetConsecteturAdipiscing2: rich("Do not press Submit twice while the page is processing.", 18.67),
    },
    label1: rich("Correct workshop", 21.33, true),
    label2: rich("Correct material and unit", 21.33, true),
    label3: rich("Correct quantities", 21.33, true),
    label4: rich("Correct Employee ID and shift", 21.33, true),
    label5: rich("Submit once and read the result", 21.33, true),
  });
  notes(slide, ["Checklist derived from validation behavior in local app /issue and server.js."]);
}

// 12 — Close
{
  const slide = buildSlide26(presentation, {
    title: rich("QUICK REFERENCE", 24, true),
    title2: {
      runs: [
        { run: "Identify. Enter.", textStyle: { fontSize: "80px", typeface: "Helvetica Neue", color: "#000000" } },
        { run: "\nVerify.", textStyle: { fontSize: "80px", typeface: "Helvetica Neue", color: "#000000" } },
      ],
      paragraphStyle: { lineSpacingPercent: 90000 },
    },
    title3: {
      loremIpsumDetails: rich("Record the correct material.", 26.67, false),
      loremIpsumDetails2: rich("Submit only once.", 26.67, false),
      loremIpsumDetails3: rich("Request a change when needed.", 26.67, false),
    },
  });
  notes(slide, ["Summary of the local Material Management workflow."]);
}

await fs.mkdir(RENDER_DIR, { recursive: true });
for (const [index, slide] of presentation.slides.items.entries()) {
  const png = await presentation.export({ slide, format: "png", scale: 1 });
  await fs.writeFile(`${RENDER_DIR}/slide-${String(index + 1).padStart(2, "0")}.png`, new Uint8Array(await png.arrayBuffer()));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(`${RENDER_DIR}/slide-${String(index + 1).padStart(2, "0")}.layout.json`, await layout.text());
}

const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
await fs.writeFile(`${ROOT}/.pptx_build/deck-montage.webp`, new Uint8Array(await montage.arrayBuffer()));

const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(OUTPUT);
console.log(OUTPUT);
