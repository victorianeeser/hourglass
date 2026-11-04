# Hourglass (working name) — Chrome extension

A personal billable-time tracker for my freelance design work. I start timers manually for a client, a small floating pill shows who I'm billing and for how long, and a toolbar popup shows totals and exports a CSV I use to make my own invoices.

This is my "1% Fix" class project: it must be fully usable and easy to hand out to classmates (they install it with Load unpacked).

## Tech
- Chrome extension, Manifest V3
- Plain HTML, CSS, and JavaScript. No frameworks, no build step, no external libraries.
- All data stays local in `chrome.storage.local`. No accounts, no servers, no network requests.
- Keep the file structure simple and well commented so I can follow it.

## Core decisions (don't change without asking)
- **Manual timers only.** Never start or switch timers automatically based on the website. I often work for several clients inside one tool (Canva, Figma), so auto-tracking would guess wrong.
- **No invoicing.** The extension ends at a clean CSV export.
- **Popup, not side panel.** Toolbar popup at 360 × 520.
- **One timer at a time.** Switching clients ends the current entry and starts a new one in a single action.
- **Store timestamps, not running counts.** Save the start time and compute elapsed time from it, because the background service worker can sleep.

## Features (v1)
1. **Clients:** add, edit, delete. Each has a name, a color (from the client palette below), and an hourly rate.
2. **Timer:** start (pick client + one or more task tags + optional note), pause/resume, stop, switch client. Last-used client is preselected, with the tasks last used for that client. While running, tap the task tag to tick or untick tasks (a checkbox dropdown); this re-tags the same session and does **not** reset the clock or split the entry. At least one task is always ticked. The clock counts up by default, or down from a set time (chosen at start or from the button beside the clock). At zero it notifies once, turns amber, and keeps tracking past zero (`+0:03:10`) until stopped; only real time worked is ever billed. Switching clients returns to counting up.
3. **Task tags**, in two groups (in this order):
   - Design: Figma, Illustrator, Photoshop, Canva, Squarespace, Other
   - Clients & admin: Email, Call, Invoice (always last; "Invoice" is a tag for time spent invoicing, not an invoicing feature)
4. **Floating pill:** shows on every webpage while a timer is running; hidden when nothing is running. Shows client color dot, client name, running time, pause button. Click to expand a small card with Pause, Stop, "Switch to" client list, and "Open dashboard".
5. **Toolbar badge:** the clock's time on the extension icon, counting up or down with it (max ~4 characters): `0:42` is hours:minutes, `:42` is seconds under a minute, `+12s` / `+3m` / `+2h` is past zero on a countdown.
6. **Dashboard (popup home):** active timer card, Today and This week totals ($ billable), hours by client, buttons for Add past time and Export CSV. Header links to Entries, Stats and Clients, plus a gear for Settings.
7. **Entries:** list by day; click to edit (client, tasks, date, start, end, note) or delete. Entries store `tasks` (a list); older entries have a single `task`, so always read them through `tasksOf()`.
8. **Add past time:** for offline work like sketching or calls.
9. **Idle check:** uses `chrome.idle` (whole computer, not just Chrome). After the set time (5 minutes by default) idle, locked, or asleep while a timer runs, ask "Keep or discard the idle time?" when you return, on the pill, as a Chrome notification, and in the popup, where a dark card replaces the timer card until answered. Discard bills up to when you left and resumes from when you returned. Shorter absences are ignored.
10. **Chrome-closed recovery:** if a timer was running when Chrome closed, next time ask: log until close, log until now, or discard.
11. **Export CSV:** choose date range and client; preview entry count, hours, and $; download. The Tasks column lists all of an entry's tasks (e.g. `Figma, Photoshop`). In Stats, an entry's time is shared evenly across its tasks so task totals add up to 100%.

12. **Settings (gear in the header):** Light / Dark / Match computer; idle check on or off and its time (1–120 minutes); floating pill on or off; Chrome notifications on or off; a link to change the keyboard shortcut. Read choices through `settingsOf()`.

## Design
- Follow the Figma design (Low-fi page). The link is kept privately in `CLAUDE.local.md`, which isn't on GitHub.
- Fonts: **DM Sans** for everything, plus **DM Mono** (its monospaced sibling) only for the running clocks in the popup and pill. Both are bundled in `fonts/`, never loaded from the web. Style DM Sans with its built-in options instead of adding more fonts: the `opsz` axis (9–40; big numbers use 40, small labels 9) and stylistic sets (`ss07` alternate numerals for big numbers, `ss04` alternate u in the wordmark).
- Timer digits must not jiggle. The clocks use DM Mono digits (equal width) with DM Sans colons (`setClock()`). DM Sans has **no tabular figures**, so `font-variant-numeric: tabular-nums` does nothing; other live DM Sans numbers (like the totals) put each digit in a fixed-width box instead (`setDigits()` + `.d { width: 0.66em }`).
- Weeks run **Sunday to Saturday** everywhere (calendar, This week, Stats).
- Popup: 360 × 520, 12px padding, 4px spacing grid. Buttons and inputs 32px tall, 6px radius. List rows 36px. Body 13px, labels 10–11px uppercase.
- Pill: 36px tall, fully rounded, fixed 24px from the bottom-right of the page, ~280px max width. Build it inside a **Shadow DOM** so website styles can't break it.
- Define all colors as CSS variables:

```css
:root {
  /* neutrals */
  --cream: #F6F3EE;   /* backgrounds */
  --paper: #FFFFFF;   /* popup surface, inputs */
  --sand: #EAE4DA;    /* cards, chips, hover */
  --line: #DDD6CB;    /* borders, dividers */
  --muted: #6E6862;   /* secondary text */
  --ink: #161412;     /* text, pill, primary buttons */
  --on-ink: #FFFFFF;
  /* accent */
  --mocha: #6E5A54;   /* links, focus — use sparingly */
  /* status */
  --running: #3DBE6B; /* only ever means "running" */
  --idle: #F2A93B;    /* paused / needs attention */
  --delete: #D9482B;  /* delete and discard only */
  /* clients — a rainbow, in this order; dots, tags, thin accents only, never big fills */
  --client-crimson: #A8233F;
  --client-tangerine: #E8781E;
  --client-lime: #A6AA0E;
  --client-forest: #2F7A2F;
  --client-lagoon: #119EAE;
  --client-cobalt: #2E4FBF;
  --client-violet: #9446D6;
  --client-peony: #EE6FA5;
}
```

Client colors were chosen so every pair is clearly different and none can be mistaken for a status color (crimson ≠ delete red, lime ≠ paused amber, forest ≠ running green). Orange and lime still look alike to colorblind viewers, so a client's name always appears next to its color. Old names map over: coral → tangerine, lilac → violet, sky → lagoon.

## How to work with me
- Build in small layers and stop after each one so I can test it in Chrome.
- Start plain and unstyled; apply the design only after the logic works.
- After each working step, commit to git with a clear message.
- Tell me exactly how to reload and test after each change.
- After changing `background.js` or `shared/data.js`, **click ↻ twice**. In testing, the first reload after a Chrome restart kept the old background worker (the badge stayed old) while the popup already showed new code. Raising `version` did not prevent this.
