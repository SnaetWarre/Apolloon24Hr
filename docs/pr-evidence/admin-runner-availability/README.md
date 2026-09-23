# Admin runner availability evidence

Base: `b9fff45` (`origin/main` when the PR branch was created). Changed code: `c160347`.

Both versions used the same disposable SQLite database with five synthetic Google Form registrations. Three selected `20-21u (dinsdag)`: one in the queue, one warming up, and one registered. Two selected only other hours. Captures were taken on `/admin` in the Lopers section at the top of the page, at 1366 × 768 and 390 × 844, with the same data, timezone (`Europe/Brussels`), and viewport for each before/after pair. The changed view has the hour filter set to `20-21u (dinsdag)`.

The headless browser check also combined the hour filter with a name search, confirmed the count changed from three to one and back, confirmed the two nonmatching people were excluded, and found no page errors.

The local data was created under `.test-data/admin-availability` with the `empty` seed and five synthetic registration rows, then served with the production build on `127.0.0.1:3187`. No production data was used.
