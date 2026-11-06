# Wrapped from Excel

Run `npm run wrapped:from-export -- --xlsx=<race.xlsx> --runner=<number or name> --out=<folder>` to rebuild one runner's four PNG pages. See `docs/wrapped.md` for limitations of the exported data.

Start a `live` verification run, open `/analysis`, and download Excel through the Exporteren menu as described in `analysis-export.md`. Run the command on that downloaded workbook. Assert four PNG files and one manifest entry for the selected runner. Compare its lap count with `/api/history?scope=full`. Run it again in the same folder after setting the entry's `sentAt` to a test value and its ID to a database ID. Assert it still has one entry with the original ID and sending time. Send no email.

Capture proofs before and after downloading the workbook. Test both a number and an exact name as selectors. The output must contain four images in either case. The workbook cannot identify split laps, so those can affect fastest and average times.
