# Beheer › Labels

Beheer › Labels lists every label by kind (Speedteams, Zusterverenigingen, Andere, Custom). The operator adds a label with a name, a color, a kind, and an optional logo, edits one in its row, or removes one.

## Sub-features

- `labels-add` adds a label with the form at the top and `Label toevoegen`. The text `<naam> is toegevoegd.` appears and the label is in its kind's group.
- `labels-edit` changes a label in its row. Not driven yet.
- `labels-members` shows who is in a label. Each row has a button `<n> lopers` that opens the list. The searchbox `Loper toevoegen aan <label>` adds the top match on Enter (the exact number first), and the match buttons `+ <nummer> <naam>` add one by click. A runner in the other speedteam shows `nu in <speedteam>` and moves on add. The × button `<naam> uit <label> halen` takes someone out. For `1ste jaar` and `Anciens`, `Misschien ook: <n> lopers` lists runners whose study phase fits but who did not tick the form box, each with `Toevoegen`. Every add or removal shows `<naam> zit nu in <label>.` or `<naam> is uit <label> gehaald.` and a line in Beheer › Activiteit.
- `labels-delete` removes a label after the question `Label <naam> verwijderen?`. It also goes off every runner. Not driven yet.

## How to get to it (user POV)

- Sidebar link `Beheer`, then the `Labels` tab, or open `/admin?section=labels`.
- The labels it holds are the ones offered in a runner's profile (`Profiel` in Beheer › Lopers) and in `Nieuwe loper`.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=ready`. It has the built-in labels.

- **Open.** `await page.goto(run.url('/admin?section=labels'))`. Wait for `getByRole('heading', { name: 'Labels', exact: true, level: 2 })`.
- **Add.** Click `getByRole('textbox', { name: 'Naam van het nieuwe label' })` and type the name, pick the kind in `getByRole('combobox', { name: 'Soort van het nieuwe label' })` (`speedteam`, `zustervereniging`, `andere`, `custom`), click `Label toevoegen`, and wait for `<naam> is toegevoegd.`. Poll `/api/state` until `labels` holds it with that `kind`.
- **Members.** Click `getByRole('button', { name: /lopers?$/ })` inside the label's `.label-admin-row`, click the searchbox, type with `page.keyboard.type`, press Enter, and poll `/api/state` until the runner's `labels` holds the label. The scenario `ready` gives study phases `1ste bachelor` and `alumnus`, so `1ste jaar` and `Anciens` have suggestions.
- **Proof.** `run.proof(page, 'labels-…')` before and after each change.

## Gotchas

- The tab buttons are in `.section-navigation`; they are buttons with `aria-pressed`, not `role=tab`.
- The heading `Labels` appears as the tab's text too. Ask for the level 2 heading.
