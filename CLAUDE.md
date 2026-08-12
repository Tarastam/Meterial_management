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
