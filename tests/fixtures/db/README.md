# Databases from released versions

`tests/schema-fixtures.test.ts` starts the app on each of these and checks that
it keeps the runners and laps, can record new laps, and ends with the same
tables as a fresh database. The package smoke test also starts the packaged app
on `v4.0.0.sqlite` and `v4.0.1-early-runners.sqlite`.

Only 4.0 and later: the app puts an older database aside
(`app.retired-<time>.sqlite`) and starts empty.

- `v<version>.sqlite`: made by that release's own database code, with three
  runners (Anna, Bert, Cas) and three laps. After a release, add one:

  ```sh
  node scripts/make-db-fixture.mjs v4.0.3
  ```

  and point `LATEST_RELEASE_FIXTURE` in the test at it.
- `v4.0.1-early-runners.sqlite`: a laptop's real database after going from the
  first version straight to 4.0.1. It says schema 14 but has the first
  `runners` table. Its admin password hash was removed.
