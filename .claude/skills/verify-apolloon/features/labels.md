# Beheer › Labels

Beheer › Labels lists every label by kind (Speedteams, Zusterverenigingen, Andere, Custom). The operator adds a label with a name, a color, a kind, and an optional logo, edits one in its row, or removes one.

## Sub-features

- `labels-add` adds a label with the form at the top and `Label toevoegen`. The text `<naam> is toegevoegd.` appears and the label is in its kind's group.
- `labels-edit` changes a label in its row. Not driven yet.
- `labels-delete` removes a label after the question `Label <naam> verwijderen?`. It also goes off every runner. Not driven yet.

## How to get to it (user POV)

- Sidebar link `Beheer`, then the `Labels` tab, or open `/admin?section=labels`.
- The labels it holds are the ones offered in a runner's profile (`Profiel` in Beheer › Lopers) and in `Nieuwe loper`.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=ready`. It has the built-in labels.

- **Open.** `await page.goto(run.url('/admin?section=labels'))`. Wait for `getByRole('heading', { name: 'Labels', exact: true, level: 2 })`.
- **Add.** Click `getByRole('textbox', { name: 'Naam van het nieuwe label' })` and type the name, pick the kind in `getByRole('combobox', { name: 'Soort van het nieuwe label' })` (`speedteam`, `zustervereniging`, `andere`, `custom`), click `Label toevoegen`, and wait for `<naam> is toegevoegd.`. Poll `/api/state` until `labels` holds it with that `kind`.
- **Proof.** `run.proof(page, 'labels-…')` before and after each change.

## Gotchas

- The tab buttons are in `.section-navigation`; they are buttons with `aria-pressed`, not `role=tab`.
- The heading `Labels` appears as the tab's text too. Ask for the level 2 heading.
