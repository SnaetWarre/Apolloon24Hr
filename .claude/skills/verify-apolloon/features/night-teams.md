# Tijdelijke nachtploegen

Beheer › Ploegen & labels plans temporary night teams. The operator creates a team with a name, a color, a start and end time, and its runners. Each team gets a card where the operator edits the member list in a dialog, changes the planned times, and switches a team without a plan on or off by hand.

## Sub-features

- `night-teams-create` creates a team with the form above the cards and `Ploeg aanmaken en plannen`.
- `night-teams-members` edits who is in a team in the `Ledenlijst beheren` dialog. Its search box has the cursor when the dialog opens.
- `night-teams-schedule` changes the start and end with `Planning aanpassen`. The `Begin` field has the cursor when the form opens.
- `night-teams-active` switches a team without a plan with `Activeren` or `Deactiveren`.

## How to get to it (user POV)

- Sidebar link `Beheer`, then the `Ploegen & labels` tab, or open `/admin?section=labels`. The cards sit under `Tijdelijke nachtploegen`.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=ready`. It has no night team, so create one in setup: `run.rpc().temporaryTeams.create.mutate({ name: 'Testploeg', color: '#7c3aed', startsAt: Date.now() + 3600_000, endsAt: Date.now() + 7200_000, runnerIds: [state.runners[0].id] })`.

- **Open.** `await page.goto(run.url('/admin?section=labels'))`. The team's card shows `Ledenlijst beheren` and `Planning aanpassen`.
- **Members.** Click `page.getByRole('button', { name: 'Ledenlijst beheren', exact: true })`. Typing with `page.keyboard.type(...)` lands in the `Zoek op nummer, naam of speedteam...` box. Click `Voeg toe` on a runner, then `Ledenlijst opslaan (N)`. The team's `memberRunnerIds` in `/api/state` holds the runner.
- **Schedule.** Click `Planning aanpassen`. `document.activeElement` is the `Begin` field (`type="datetime-local"`). Change the times and click `Planning opslaan`. The team's `startsAt` and `endsAt` change in `/api/state`.
- **Proof.** `run.proof(page, 'night-teams-…')` after each step.

## Gotchas

- A runner can be in only one night team. Creating a second team with the same runner fails with `Een loper kan maar in een tijdelijke nachtploeg zitten`, and two teams cannot share a name.
- When the members search finds nobody, the search box stretches to fill the column. That is an old layout problem, not a failed search.
