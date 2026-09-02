# CLAUDE.md

Instructions for Claude Code when working in this repository.

## Change Log Policy

Every time you `git push` or create/update a pull request, append a new
entry to the **Change Log** section below **before** ending your turn.

- Add the entry as a new block at the **top** of the log (newest first).
- Use the format shown by existing entries: date, branch, and a short
  bullet list of what changed and why (not just filenames).
- Do this whether the push/PR was requested directly or happened as part
  of a larger task — the log should stay a complete record of what left
  the local machine.
- If you amend/force-push over an entry that's already logged, update
  that entry instead of duplicating it.

## Change Log

<!-- Newest entries go on top. -->

### 2026-09-02 — main
- Merged `feature/process-maps-consumption-user-management` into `main`
  locally (`gh` CLI unavailable, so via `git merge --no-ff` + `git push`,
  at the user's explicit request) and pushed `a09b087`. Clean merge, no
  conflicts.

### 2026-09-02 — feature/process-maps-consumption-user-management
- Branched off `main` (`c69af33`) and pushed `fc8300f` (`gh` CLI still
  unavailable in this environment, so the PR to `main` needs to be opened
  manually from the compare link). The prior working branch
  (`feature/ticket-attachments-and-transaction-improvements`) had no net
  diff vs. `main` at HEAD — all the real new work below was sitting
  uncommitted in the working tree, so it was committed fresh onto this
  new branch instead, leaving unrelated untracked files (pptx decks,
  xlsx exports, desktop.ini, mes_deck_* dirs) out of the commit.
- Added a `/process-map` suite (operation-to-workshop mapping, series
  view with batch toggles, part-number assignment, serie-workshop
  linking) gated behind a new `process_map` permission.
- Added `/admin/users`, a master-only page for creating users, editing
  per-page permissions, resetting passwords, and deleting accounts.
- Added `/reports/monthly-consumption` with CSV/XLSX export.
- Materials gained standalone create/edit/delete routes and pages under
  `materials_manage` permission (previously inline-edit-only).
- Transactions gained an edit route alongside the existing
  void/bulk-void actions.

### 2026-08-21 — main
- Merged `feature/ticket-attachments-and-transaction-improvements` into
  `main` locally (`gh` CLI unavailable, so via `git merge --no-ff` +
  `git push`, at the user's explicit request) and pushed `b6d924b`. Clean
  merge, no conflicts.

### 2026-08-21 — feature/ticket-attachments-and-transaction-improvements
- Pushed `2b70811` (`gh` CLI still unavailable in this environment, so the
  PR to `main` needs to be opened manually from the compare link).
- `/consumption` now pulls Product Output directly from ProductionMES
  (`DashboardWipProcessDaily`, filtered by OperationName + Serie) instead
  of a manual entry field, with a daily usage/output/consumption
  breakdown, chart data, and a new CSV export at
  `/export/consumption.csv`.
- Materials gain Unit Cost and STD Consumption fields (material form,
  create/edit, admin-only inline editing via
  `/materials/:id/inline-update`), surfaced as sortable Cost/Usage
  Cost/STD Consumption columns on the materials list.
- Added `fmtConsumption()` to display small consumption ratios at 3
  significant figures instead of a fixed decimal count that either hid
  the value or buried it in trailing zeros.
- Tickets-by-Workshop dashboard chart now breaks down by ticket type
  instead of shift.

### 2026-08-14 — feature/ticket-attachments-and-transaction-improvements
- Pushed `539f9b1` (`gh` CLI unavailable in this environment, so the PR to
  `main` still needs to be opened manually from the compare link).
- `src/db.js` refactored into a `createDbClient(config)` factory so the app
  can hold two separate connection pools: the existing primary TaMFGdb and
  a new ProductionMES connection (`DB2_*` env vars), exposed as `db.mes`.
- `scripts/test-db-connection.js` now exercises both pools through the
  shared client instead of duplicating connection setup.
- `/issue` skips materials left completely untouched in a submission
  instead of recording them as a blank entry (previously any material
  present in the form, even with no fields filled in, got inserted).
- Added `/export/transactions.csv?daily=1`: one row per material per
  calendar day in range, with Current Stock carried forward on days with
  no entry, for paper-style daily stock reports. Transactions page CSV
  export link now points at this daily grid instead of per-entry rows.

### 2026-08-12 — feature/ticket-attachments-and-transaction-improvements
- Pushed `1b26f28` and `60f1c8a`, then opened a PR to `main`.
- List actions (edit/delete/resolve/void on materials, tickets,
  transactions) now redirect back to the filtered/sorted list instead
  of the bare list URL.
- Dashboard usage anomalies restricted to admins; split into
  abnormal-usage vs. missing-entry categories with filter buttons; the
  in-progress current day is no longer flagged as a missing entry.
- Blank Current Stock on `/issue` now carries the prior day's value
  forward instead of being skipped (was producing false "no entry"
  anomalies).
- Added admin bulk-void on the transactions list.
- Added a placeholder "Material Request" nav section (coming-soon
  pages) ahead of the call-in feature in
  `material-request-system-design.md`.
- Removed the Top 5 Issued Materials dashboard panel; dashboard
  filters moved into a floating bottom bar.
- Added 3 one-off data-correction scripts (TA0168 unit fix, TA0212
  cost, ANODIZE entry_date shift) for the audit trail.

### 2026-08-11 — feature/ticket-attachments-and-transaction-improvements
- Set up this Change Log policy and CLAUDE.md file (no code changes pushed yet).

### Prior history (seeded from `git log`, pre-dates this policy)
- `32c1ed5` Add transactions undo/change, per-material decimal display, ticket type filter, and grouped nav
- `d013514` Merge origin/feature/ticket-attachments-and-transaction-improvements
- `e287f6b` Open Ticket Log to all users, add date/workshop filters and delete; entry date now cuts over at Thai 7am
- `4f3fd43` Merge pull request #2 from Tarastam/main
- `0421104` Merge pull request #1 from Tarastam/feature/ticket-attachments-and-transaction-improvements
- `e959243` Add ticket detail modal, transactions search/usage column, fix timestamp offset
- `6fee27d` Add ticket attachments, block negative usage, improve transactions view
- `a07b0b0` Initial commit: Material Management app
