// Playwright helpers for driving a run started by verify.mjs. Import it by absolute path from a
// drive script anywhere; it resolves playwright and tRPC from the repo's node_modules.
//
//   import { openRun } from '/home/.../apolloon/.claude/skills/verify-apolloon/scripts/drive.mjs';
//   const run = await openRun();                 // the only live run, or APOLLOON_VERIFY_RUN
//   const page = await run.newPage();            // headless Chromium, 1366x768, on laptop 0
//   await page.goto(run.url('/timing'));
//   await run.proof(page, 'before-press');       // screenshot + ARIA snapshot + /api/state
//   await run.close();
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '../../../..');
const scratchRoot = path.join(repoRoot, '.tmp-verify');

/** The user agent the Electron app sends. Failover reads it: the Electron app stays on its own laptop. */
export const ELECTRON_USER_AGENT = 'Mozilla/5.0 Chrome/140.0 Electron/44.3.0 Safari/537.36';

export async function openRun(runName = process.env.APOLLOON_VERIFY_RUN) {
  const state = readRun(runName);
  const browser = await chromium.launch({ headless: true });
  let proofCount = fs.readdirSync(state.evidenceDir).filter((name) => name.endsWith('.png')).length;
  const notes = path.join(state.evidenceDir, 'actions.log');
  const cdpConnections = [];
  const filmStarts = new WeakMap();

  const run = {
    state,
    browser,
    evidenceDir: state.evidenceDir,
    /** Full address on a laptop: run.url('/queue'), run.url('/admin?section=system', 1). */
    url: (route = '/', laptop = 0) => `${state.laptops[laptop].url}${route}`,
    /**
     * colorScheme: 'light' | 'dark' picks the theme the app starts in. reducedMotion: 'reduce' is the OS
     * setting that shortens every animation. video: true films the page for run.film().
     */
    async newPage({
      laptop = 0,
      electron = false,
      viewport = { width: 1366, height: 768 },
      colorScheme,
      reducedMotion,
      video = false,
    } = {}) {
      const context = await browser.newContext({
        viewport,
        ...(electron ? { userAgent: ELECTRON_USER_AGENT } : {}),
        ...(colorScheme ? { colorScheme } : {}),
        ...(reducedMotion ? { reducedMotion } : {}),
        ...(video ? { recordVideo: { dir: path.join(state.evidenceDir, 'video'), size: viewport } } : {}),
      });
      const page = await context.newPage();
      if (video) filmStarts.set(page, Date.now());
      page.on('pageerror', (error) => run.note(`pageerror on laptop ${laptop}: ${error.message}`));
      return page;
    },
    /** The page inside the desktop window started by `verify.mjs electron`, with the preload bridge. */
    async electronPage() {
      if (!state.electron) throw new Error(`Start the desktop window first: verify.mjs electron --run=${state.run}`);
      const desktop = await chromium.connectOverCDP(state.electron.cdpUrl);
      cdpConnections.push(desktop);
      const page = desktop
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('http'));
      if (!page) throw new Error('No app page in the desktop window');
      return page;
    },
    /** Server state as the app sees it. Read-only; use it to prove side effects. */
    async api(route, laptop = 0) {
      const response = await fetch(`${state.laptops[laptop].url}${route}`);
      if (!response.ok) throw new Error(`${route} answered ${response.status}`);
      if (route.includes('.xlsx')) return Buffer.from(await response.arrayBuffer());
      return route.includes('.csv') ? response.text() : response.json();
    },
    /** tRPC client for SETUP only (moving runners into position). Never use it for the action you prove. */
    rpc: (laptop = 0) => createTRPCClient({ links: [httpBatchLink({ url: `${state.laptops[laptop].url}/trpc` })] }),
    /** Appends one line to actions.log in the evidence folder: what you did and what you saw. */
    note(line) {
      fs.appendFileSync(notes, `${new Date().toISOString()} ${line}\n`);
      console.log(line);
    },
    /** Saves NN-name.png, NN-name.aria.yml, and NN-name.state.json for the given page. */
    async proof(page, name, { laptop = 0, fullPage = false } = {}) {
      proofCount += 1;
      const base = path.join(state.evidenceDir, `${String(proofCount).padStart(2, '0')}-${name}`);
      // Dialogs fade in; wait for finite animations so the screenshot shows the settled screen.
      // Endless ones (live dots, the outside flash pulse) never finish and are skipped.
      await page
        .waitForFunction(
          () =>
            document
              .getAnimations()
              .every(
                (animation) =>
                  animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity
              ),
          null,
          { timeout: 3_000 }
        )
        .catch(() => run.note(`proof ${name}: animations still running after 3 s`));
      await page.screenshot({ path: `${base}.png`, fullPage });
      fs.writeFileSync(`${base}.aria.yml`, `# ${page.url()}\n${await page.locator('body').ariaSnapshot()}\n`);
      const appState = await run.api('/api/state', laptop);
      fs.writeFileSync(`${base}.state.json`, `${JSON.stringify(appState, null, 2)}\n`);
      run.note(`proof ${path.basename(base)} at ${page.url()}`);
      return base;
    },
    /**
     * Ends a page opened with { video: true } and saves NN-name.webm plus NN-name.strip.png, a grid of
     * frames that shows motion as one image. `from` is a Date.now() taken just before the action, so the
     * strip starts there instead of at page load. `clip` ({ x, y, width, height }, for example from
     * locator.boundingBox()) crops every frame to one element. Closes the page's context, so film at the end of a scene.
     */
    async film(page, name, { from, clip, fps = 10, columns = 5, rows = 4, width = 480 } = {}) {
      const video = page.video();
      if (!video) throw new Error('Open the page with run.newPage({ video: true }) to film it');
      await page.context().close();
      proofCount += 1;
      const base = path.join(state.evidenceDir, `${String(proofCount).padStart(2, '0')}-${name}`);
      fs.renameSync(await video.path(), `${base}.webm`);
      const skip = String(from ? Math.max(0, from - filmStarts.get(page)) / 1000 : 0);
      const crop = clip ? `crop=${[clip.width, clip.height, clip.x, clip.y].map(Math.round).join(':')},` : '';
      const grid = `${crop}fps=${fps},scale=${width}:-1,tile=${columns}x${rows}`;
      const strip = `${base}.strip.png`;
      execFileSync('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-ss',
        skip,
        '-i',
        `${base}.webm`,
        '-vf',
        grid,
        '-frames:v',
        '1',
        strip,
      ]);
      run.note(`film ${path.basename(base)}: ${columns * rows} frames at ${fps} per second`);
      return base;
    },
    async close() {
      // Disconnects from the desktop window without closing it; `verify.mjs down` stops it.
      for (const connection of cdpConnections) await connection.close();
      await browser.close();
    },
  };
  run.note(
    `open run=${state.run} commit=${state.commit.slice(0, 7)} laptops=${state.laptops.map((l) => l.url).join(',')}`
  );
  return run;
}

function readRun(runName) {
  const runs = fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot) : [];
  const name = runName || (runs.length === 1 ? runs[0] : null);
  if (!name) {
    throw new Error(
      runs.length
        ? `Several runs (${runs.join(', ')}); set APOLLOON_VERIFY_RUN`
        : 'No run; start one with verify.mjs up'
    );
  }
  const file = path.join(scratchRoot, name, 'state.json');
  if (!fs.existsSync(file)) throw new Error(`No run named ${name}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
