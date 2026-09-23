# Runner registration profile UI

- Base: `5fe60a8` (`origin/main`), identical UI tree to local `main` at capture time.
- Changed: `302e917` (registration profile and queue changes).
- Route: `/queue`, viewport: 1366 × 768, headless Chrome, Europe/Brussels.
- Data: disposable `ready` seed, filtered to warming-up runner `123 - Amira El Idrissi`.
- Both captures used the same `/api/state` response with one synthetic Google Form registration on that runner: study phase `1ste bach`, estimated pace `1′17″-1′19″`, categories `Eerstejaars, Vrouw`, availability and other answers. The base UI ignores the new registration fields; the changed UI shows them.
- Queue captures show the filtered warming-up row. Profile captures show the open runner profile. No browser errors were observed in either capture.
- Evidence uses synthetic contact data and contains no actual form responses.
