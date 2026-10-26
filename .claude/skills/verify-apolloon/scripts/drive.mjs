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
    /**
     * Saves NN-name.png, NN-name.aria.yml, and NN-name.state.json for the given page. With `mark`, a list
     * of locators or { x, y, width, height } boxes, it also saves NN-name.marked.png with a numbered red
     * ring around each one, in list order, for the PR's before and after table.
     */
    async proof(page, name, { laptop = 0, fullPage = false, mark = [] } = {}) {
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
      if (mark.length) await markScreenshot(page, `${base}.marked.png`, mark, fullPage, run.note);
      run.note(`proof ${path.basename(base)} at ${page.url()}`);
      return base;
    },
    /**
     * Ends a page opened with { video: true } and saves, from `from` (a Date.now() taken just before the
     * action) to the end of the scene, cropped to `clip` ({ x, y, width, height }, for example a
     * locator's boundingBox()):
     * - NN-name.gif, which plays and loops by itself in a PR's before and after table;
     * - NN-name.mp4, for clips too long or too large for a GIF (GitHub plays it as a video);
     * - NN-name.frames.png, 9 numbered frames 200 ms apart in a grid, only for an agent to look at
     *   the motion, since it cannot watch a video. Never put it in a PR.
     * Closes the page's context, so film at the end of a scene.
     */
    async film(page, name, { from, clip } = {}) {
      const video = page.video();
      if (!video) throw new Error('Open the page with run.newPage({ video: true }) to film it');
      const screen = page.viewportSize();
      await page.context().close();
      proofCount += 1;
      const base = path.join(state.evidenceDir, `${String(proofCount).padStart(2, '0')}-${name}`);
      // Keep the crop inside the frame, so a padded bounding box near an edge still works.
      const x = Math.max(0, Math.round(clip?.x ?? 0));
      const y = Math.max(0, Math.round(clip?.y ?? 0));
      const cropWidth = clip && Math.min(screen.width - x, Math.round(clip.x + clip.width) - x);
      const cropHeight = clip && Math.min(screen.height - y, Math.round(clip.y + clip.height) - y);
      const crop = clip ? `crop=${cropWidth}:${cropHeight}:${x}:${y},` : '';
      const skip = String(from ? Math.max(0, from - filmStarts.get(page)) / 1000 : 0);
      const input = ['-loglevel', 'error', '-y', '-ss', skip, '-i', await video.path()];
      // Even sizes, at most 960 wide: H.264 needs even sizes and a GIF wider than that gets heavy.
      const scale = "scale='min(960,iw)':-2:flags=lanczos";
      const gif = `${crop}fps=20,${scale},split[a][b];[a]palettegen[p];[b][p]paletteuse`;
      execFileSync('ffmpeg', [...input, '-vf', gif, `${base}.gif`]);
      const mp4 = ['-vf', `${crop}${scale}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
      execFileSync('ffmpeg', [...input, ...mp4, `${base}.mp4`]);
      // The frame number sits on a dark box so it reads on both themes.
      const number =
        "drawtext=font=Sans:text='%{eif\\:n+1\\:d}':x=10:y=10:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=8";
      const frames = `${crop}fps=5,scale=640:-2,${number},tile=3x3:padding=16:margin=16:color=0x808080`;
      execFileSync('ffmpeg', [...input, '-vf', frames, '-frames:v', '1', `${base}.frames.png`]);
      run.note(`film ${path.basename(base)}: .gif, .mp4, and .frames.png`);
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

// The rings are page elements that live only for this one screenshot. They sit in a popover, because only
// the top layer draws above an open dialog. Red with a white edge reads on both themes; the number sits
// outside the ring so it never covers what it points at.
async function markScreenshot(page, file, mark, fullPage, note) {
  if (fullPage) throw new Error('mark draws on the visible screen; leave fullPage off');
  const boxes = [];
  for (const [index, target] of mark.entries()) {
    // On the base run the new element is often missing; skip it instead of waiting for it.
    const isLocator = typeof target.boundingBox === 'function';
    const box = isLocator ? (await target.count()) && (await target.boundingBox()) : target;
    if (box) boxes.push({ ...box, number: index + 1 });
    else note(`mark ${index + 1} in ${path.basename(file)}: not on screen, no ring drawn`);
  }
  await page.evaluate((rings) => {
    const layer = document.createElement('div');
    layer.id = 'verify-marks';
    layer.popover = 'manual';
    layer.style.cssText =
      'position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none';
    for (const ring of rings) {
      const pad = 6;
      const left = ring.x - pad;
      const top = ring.y - pad;
      const outline = document.createElement('div');
      outline.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${ring.width + 2 * pad}px;height:${ring.height + 2 * pad}px;border:4px solid #e0102f;border-radius:12px;box-sizing:border-box;box-shadow:0 0 0 2px #fff,inset 0 0 0 2px #fff`;
      const badge = document.createElement('div');
      badge.textContent = String(ring.number);
      badge.style.cssText = `position:absolute;left:${Math.max(0, left - 14)}px;top:${Math.max(0, top - 14)}px;width:28px;height:28px;border-radius:50%;background:#e0102f;color:#fff;font:700 16px/28px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff`;
      layer.append(outline, badge);
    }
    document.body.append(layer);
    layer.showPopover();
  }, boxes);
  await page.screenshot({ path: file });
  await page.evaluate(() => document.getElementById('verify-marks')?.remove());
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
