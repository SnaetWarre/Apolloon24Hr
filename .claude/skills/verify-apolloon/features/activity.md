# Activiteit

Beheer › Activiteit lists every change to the event data, newest first, with the screen and the laptop or browser it came from. Operators read it to find the moment before a mistake, so they can restore the right backup. Each line says in Dutch what changed; a runner profile save names only the fields whose value really changed.

## Sub-features

- `activity-list` shows each change with its time, a Dutch summary, and where it came from.
- `activity-profile-fields` names only the profile fields a save really changed (`naam`, `nummer`, `notities`, `telefoon`, `e-mail`, `uren`, `labels`), or `niets gewijzigd`.
- `activity-search` filters the list on runner, label, or address.
- `activity-queue-moves` hides warm-up and queue moves until `Wachtrij-bewegingen tonen` is checked.

## How to get to it (user POV)

- Beheer › Activiteit: open `/admin?section=activity`.
- A runner profile save, which adds a line, starts from Beheer › Lopers (`Profiel` in the runner's row) or from Wachtrij (click the runner's name on the board).

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=ready`. The list starts empty; each action below adds a line.

- **Open.** `await page.goto(run.url('/admin?section=activity'))`. Heading `Activiteit` and searchbox `Activiteit doorzoeken` are visible; an empty list reads `Nog geen activiteit.`
- **Profile from Beheer › Lopers.** On `/admin?section=runners`, click `page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Profiel' })`. In `page.getByRole('dialog', { name: 'Lopersprofiel' })` change only `getByLabel('Notities')` and click `Opslaan`. The newest line reads `#<nummer> <naam> aangepast (notities)` with `Beheer · laptop …`.
- **Profile from Wachtrij.** On `/queue`, click `button.queue-identity` with the runner's name, change only `getByLabel('Telefoon')`, and click `Opslaan`. The newest line reads `… aangepast (telefoon)` with `Wachtrij · laptop …`; `/api/registrations` holds the new phone.
- **Read a line.** `page.locator('.activity-table tbody tr').first().locator('td').nth(1)` is the newest summary.
- **Proof.** `run.proof(page, 'activity-…')` after editing the profile and after opening Activiteit.

## Gotchas

- The table only loads while the Activiteit tab is open. Navigate to it after the change instead of waiting on an open tab.
- `runners.setStatus` and `runners.reorder` lines are hidden by default, so check-ins and queue moves do not show without the checkbox.
- The time column is the browser's locale time; compare summaries, not times.
