# Hourglass

A personal billable-time tracker for freelance design work. Start a timer for a client, see totals, and export a CSV for your invoices. Everything stays on your computer.

## Install (Load unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose this folder (the one with `manifest.json`).
5. Pin Hourglass from the puzzle-piece menu so it shows in your toolbar.
6. Refresh any tabs that were already open, so the floating pill can appear on them.

Chrome will say the extension can "read and change your data on all websites". That's only so the floating pill can appear on every page; Hourglass never reads page content and never sends anything anywhere.

Shortcut: **Option+Shift+H** (Mac) or **Alt+Shift+H** (Windows) opens the popup. Change it at `chrome://extensions/shortcuts`.

## Files

- `manifest.json` — tells Chrome what the extension is and what it can do
- `background.js` — keeps the toolbar badge showing the running time; opens the dashboard for the pill
- `pill/pill.js` — the floating pill on every webpage (built in a Shadow DOM so sites can't restyle it)
- `icons/` — the logo, plus the toolbar and extension-page icons made from it
- `shared/data.js` — all saving and loading (clients, entries, timer) plus totals math
- `popup/` — the toolbar popup: `popup.js` draws one screen at a time, `popup.css` has the design
- `fonts/` — DM Sans, plus DM Mono for the running clock (both Open Font License), bundled so the extension never goes online
