# Material Management

Simple local-network material stock tracking app. Replaces the manual Excel process with validated, dropdown-driven forms, a low-stock dashboard, and a full transaction audit trail (mistakes are corrected with "Void", not deletion).

Built on Node.js (Express + SQLite) — no Python required.

## Setup

```
npm install
npm run import
```

This creates `data/material_management.db` and imports the 214 materials from `Material_List_seed.csv` (a plain-CSV export of `Material_List.xlsx`, kept alongside it so the import script has no Excel-parsing dependency). Safe to re-run `npm run import` any time.

## Run

```
npm start
```

Then open `http://<this-pc-ip>:8000` from any device on the local network, or `http://localhost:8000` on this machine.

## First-time use

1. Go to **Employees** and add your team's names (used as a dropdown on stock-in/out forms so names are always spelled consistently).
2. Go to **Materials** to review the imported list, or add new materials as needed.
3. Use **Stock In** / **Stock Out** to record movements. Stock-out is blocked if it would exceed current stock.
4. Check the **Dashboard** for low-stock alerts and recent activity.
5. If a mistake was entered, go to **Transactions** and click **Void** (enter a reason) — this reverses the effect on stock while keeping a record of what happened.
