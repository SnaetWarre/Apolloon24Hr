# Analyse › Exporteren

The `Exporteren` button in the Analyse header opens a menu with six downloads of the whole race, whatever labels the screen filters on. Each link saves a file and leaves the app on Analyse; in the desktop window there is no back button, so a link that opens the file instead would strand the operator.

## Sub-features

- `analysis-export-excel` downloads `apolloon-race.xlsx` (`Excel: rondes en gebeurtenissen`) with laps and race events.
- `analysis-export-csv` downloads `apolloon-laps.csv` (`Rondes (CSV)`) and `apolloon-events.csv` (`Gebeurtenissen (CSV)`), with a UTF-8 BOM and formula-like names quoted.
- `analysis-export-json` downloads `apolloon-laps.json` (`Rondes (JSON)`), `apolloon-current-state.json` (`Volledige toestand (JSON)`), and `apolloon-events.json` (`Gebeurtenissen (JSON)`).
- `analysis-export-stay` keeps the page on `/analysis` after every click, with the title bar and sidebar in place in the desktop window.

## How to get to it (user POV)

- Sidebar `Analyse` (`/analysis`), then `Exporteren` in the header, then one of the six links.
- The same files at `/api/export/race.xlsx`, `laps.csv`, `laps.json`, `current-state.json`, `events.csv`, and `events.json`, for a browser or a script.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=live`, so there are laps to export. Its race has no race events, so both event files hold only a header or `{"events":[]}`.
- For the desktop window: port 5173 is free, then `up --run=desk --port=5173 --scenario=live`, `npm run electron:compile`, and `verify.mjs electron --run=desk` (see `desktop-window.md`).

- **Open the menu.** `await page.goto(run.url('/analysis'))`, wait for heading `Analyse`, then `page.locator('summary', { hasText: 'Exporteren' }).click()`. The six links appear by their exact names above. The menu stays open after a download and closes on a click elsewhere or Escape; clicking `Exporteren` again closes it, so check `page.locator('details.analysis-export').evaluate((menu) => menu.open)` first.
- **Download in a browser.** In `run.newPage()`, `Promise.all([page.waitForEvent('download'), link.click()])`. `download.suggestedFilename()` is the `apolloon-…` name from the server's `Content-Disposition`; `page.url()` is still `/analysis`. Compare the laps file with `run.api('/api/export/laps.json')`. Read a saved `.xlsx` with `read-excel-file/node` from the repo's `node_modules`: its sheets are `Rondes` and `Gebeurtenissen`.
- **Desktop window.** In `run.electronPage()`, deny downloads first: `const cdp = await page.context().browser().newBrowserCDPSession()`, `cdp.on('Browser.downloadWillBegin', …)`, and `cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true })`. Click a JSON link: `downloadWillBegin` names the file, `page.url()` stays `/analysis`, and `.titlebar` and navigation `Hoofdnavigatie` are both still there.
- **Headers.** `curl -sD - -o /dev/null <url>/api/export/<file>` shows `Content-Disposition: attachment; filename="apolloon-…"` for all six.
- **Proof.** `run.proof(page, 'analysis-export-…')` with the menu open and after each click.

## Gotchas

- In the desktop window, never click a link without the CDP `deny` above: Electron would open a save dialog on the user's real screen. Check the Excel and CSV links in a headless browser page or with curl instead.
- The desktop window opens DevTools beside the page, so its screenshots are only about 160 px wide. Use the browser page for a full-size screenshot.
- The exports always hold the full race; turning labels off on Analyse does not change the files.
- The Excel file shows `Binnen` and `Tijdstip` in Brussels clock time, like the screens, whatever time zone the server runs in (summer or winter time as on that date). The CSV files keep ISO times in UTC with a `Z`; the JSON files hold epoch milliseconds (`finishedAt: 1791538821735`). To check the Excel times, start the run with `TZ=UTC node .claude/skills/verify-apolloon/scripts/verify.mjs up …` (the servers inherit `TZ`) and compare the first `Binnen` cell, read as UTC, with the oldest lap's `finishedAt` formatted in `Europe/Brussels`. The sheet lists the oldest lap first; `laps.json` lists the newest first, so that lap is its last entry.
