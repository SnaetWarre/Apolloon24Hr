// Run only against a disposable verify-apolloon run started for this capture.
import { openRun } from '../../.agents/skills/verify-apolloon/scripts/drive.mjs';
const run = await openRun();
const routes = [
  ['overview', '/'],
  ['queue', '/queue'],
  ['timing', '/timing'],
  ['analysis', '/analysis'],
  ['tactics', '/tactics'],
  ...['preparation', 'runners', 'laps', 'labels', 'public', 'activity', 'system'].map((s) => [
    `admin-${s}`,
    `/admin?section=${s}`,
  ]),
  ['inside', '/display/inside'],
  ['competitions', '/display/competitions'],
  ['outside', '/display/outside'],
];
try {
  for (const theme of ['light', 'dark']) {
    const page = await run.newPage({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((theme) => localStorage.setItem('apolloon.theme', theme), theme);
    for (const [name, route] of routes) {
      await page.goto(run.url(route));
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      await run.proof(page, `reference-${theme}-${name}`);
    }
    await page.close();
  }
} finally {
  await run.close();
}
