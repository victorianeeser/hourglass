# Chrome Web Store listing: copy and paste

## Store listing tab

**Summary** (also the description in manifest.json)

Manual billable-time tracker for freelance design work. All data stays on your computer.

**Description**

Hourglass is a simple billable-time tracker for freelancers. You start a timer for a client, and a small floating pill shows who you're billing and for how long on every webpage.

Timers are always manual. Hourglass never guesses from the website you're on, because one tool like Figma or Canva can hold work for several clients.

What you can do:
• Start, pause, resume, stop, or switch clients in one click
• Tag work with one or more tasks, like Figma, Photoshop, Email, or Invoice
• See running time on the toolbar icon and in the floating pill
• See today's and this week's billable totals at a glance
• Browse your work in a list or a monthly calendar, and edit any entry
• Add past time for offline work like sketching or calls
• See stats by week, month, or year, broken down by client and task
• Export a clean CSV to build your own invoices
• Use light or dark mode

Private by design: there are no accounts, servers, or analytics. Everything is stored in Chrome on your computer. Removing the extension deletes your data, so export anything you want to keep first.

**Category:** Productivity (Tools or Workflow & Planning, whichever the dashboard offers)

**Language:** English

**Icon:** `icons/icon128.png`

**Screenshots:** `store/screenshot-1.png`, `store/screenshot-2.png` (1280×800, fictional sample data)

## Privacy tab

**Single purpose**

Track billable time manually by client, show the running timer while you work, and export the logged time as a CSV.

**Permission justifications**

- `storage`: Saves the user's clients, time entries, running timer, and settings locally in Chrome.
- `alarms`: Updates the running time on the toolbar badge once a minute while the background worker is asleep.
- Host permission / content script on all sites (`<all_urls>`): Shows the floating timer pill on whatever webpage the user is working on, so they can see and control the timer without opening the popup. The extension does not read, collect, or change page content.
- Web accessible resources (`shared/data.js`, the two fonts): Lets the pill load its own code and fonts on webpages. These files contain no user data.

**Remote code:** No, I am not using remote code.

**Data usage:** Check nothing. Hourglass doesn't collect or transmit any user data. Then certify the three statements (not sold, not used for unrelated purposes, not used for creditworthiness or lending).

**Privacy policy URL** (only if the dashboard requires one): publish the text below somewhere public, such as a GitHub page, and paste the link.

> Hourglass stores all of your data (clients, rates, notes, and time entries) locally in Chrome on your computer. It has no accounts or servers and doesn't collect, transmit, sell, or share any data. Removing the extension deletes this data.

## Distribution tab

**Visibility:** Unlisted, for class use (only people with the link can install it). Choose Public to appear in search.

**Payment:** Free. **Regions:** All regions.

## Updating later

1. Raise `"version"` in `manifest.json`.
2. Run `./package.sh` to build a new zip in `store/`.
3. In the dashboard, open Package, upload the new zip, and submit it for review.
