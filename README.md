# Hourglass

A personal billable-time tracker for freelance design work. Start a timer for a client, see totals, and export a CSV for your invoices. Everything stays on your computer.

## Install (Load unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose this folder (the one with `manifest.json`).
5. Pin Hourglass from the puzzle-piece menu so it shows in your toolbar.

## Files

- `manifest.json` — tells Chrome what the extension is and what it can do
- `shared/data.js` — all saving and loading (clients, entries, timer) plus totals math
- `popup/` — the toolbar popup: `popup.js` draws one screen at a time, `popup.css` has the design
- `fonts/` — DM Sans (Open Font License), bundled so the extension never goes online
