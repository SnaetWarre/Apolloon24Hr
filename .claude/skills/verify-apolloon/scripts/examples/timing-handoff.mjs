#!/usr/bin/env node
// Proves the Timing spacebar flow on a fresh `ready` run: the first press starts the race and the
// first runner, a second press saves a lap and starts the next runner. Copy this as a starting point.
// Usage: APOLLOON_VERIFY_RUN=<run> node .claude/skills/verify-apolloon/scripts/examples/timing-handoff.mjs
import assert from 'node:assert/strict';
import { openRun } from '../drive.mjs';

const run = await openRun();
try {
  const before = await run.api('/api/state');
  assert.equal(before.race.raceStartedAt, null, 'Needs a run seeded with --scenario=ready that nobody has started');
  const page = await run.newPage();
  await page.goto(run.url('/timing'));
  const startButton = page.getByRole('button', { name: /^Start / });
  await startButton.waitFor();
  const firstName = (await startButton.innerText()).split('\n')[0].trim();
  await run.proof(page, 'timing-before-start');

  run.note(`press Space on /timing (button reads "${firstName}")`);
  await page.keyboard.press('Space');
  await page.getByText('Loper gestart.', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Klok / }).waitFor();
  const started = await run.api('/api/state');
  assert.ok(started.race.raceStartedAt, 'the race clock started');
  assert.ok(started.race.activeRunnerId, 'a runner is on the track');
  await run.proof(page, 'timing-after-start');

  // Within 20 s of the start Timing asks whether this was a double press; confirming counts the lap.
  run.note('press Space again, confirm "Toch afklokken"');
  await page.keyboard.press('Space');
  const prompt = page.getByRole('dialog', { name: 'Toch afklokken?', exact: true });
  await prompt.waitFor();
  await run.proof(page, 'timing-short-lap-question');
  await prompt.getByRole('button', { name: 'Toch afklokken', exact: true }).click();
  await page.getByText(/^Ronde opgeslagen\./).waitFor();
  await run.proof(page, 'timing-after-handoff');

  const { laps } = await run.api('/api/history?scope=full');
  const after = await run.api('/api/state');
  assert.equal(laps.length, 1, 'exactly one lap was saved');
  assert.equal(laps[0].runnerId, started.race.activeRunnerId, 'the lap belongs to the runner who was on the track');
  assert.notEqual(after.race.activeRunnerId, started.race.activeRunnerId, 'the next runner is on the track');
  run.note(
    `PASS lap ${laps[0].durationMs} ms saved for runner ${laps[0].runnerId}; next runner ${after.race.activeRunnerId}`
  );
} finally {
  await run.close();
}
