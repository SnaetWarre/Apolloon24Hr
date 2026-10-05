/**
 * Looks up the newest published version. The source repository is private, so every
 * release is copied to a public one (.github/workflows/publish-public-release.yml),
 * which the app reads without a token and links to for the download.
 *
 * On Windows and from an AppImage, electron/updates.ts downloads and installs it in the
 * app instead; this check is what the other installs (macOS, development) and a failed
 * updater fall back to.
 */
export const RELEASES_REPO = 'SnaetWarre/apolloon-releases';
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

export type AvailableUpdate = {
  version: string;
  /** The release page with its changes. */
  pageUrl: string;
  /** The installer for this operating system, or null when the release has none. */
  downloadUrl: string | null;
  publishedAt: number | null;
};

export type UpdateStatus =
  | { state: 'checking'; checkedAt: number | null }
  | { state: 'current'; checkedAt: number }
  /** No internet, which is normal at the event, or the release source did not answer. */
  | { state: 'unreachable'; checkedAt: number }
  /** A newer version to download and install by hand; `problem` says why the app did not do it. */
  | { state: 'available'; checkedAt: number; update: AvailableUpdate; problem: string | null }
  | { state: 'downloading'; checkedAt: number; update: AvailableUpdate; percent: number }
  /** Downloaded and checked: one click installs it and reopens the app. */
  | { state: 'ready'; checkedAt: number; update: AvailableUpdate }
  | { state: 'installing'; checkedAt: number; update: AvailableUpdate };

/** How the last update installed from the app went, told once after the restart. */
export type InstallOutcome = { version: string; ok: boolean };

type ReleaseAsset = { name?: unknown; browser_download_url?: unknown };
type ReleaseJson = { tag_name?: unknown; html_url?: unknown; published_at?: unknown; assets?: unknown };

/** Compares `major.minor.patch`; a pre-release such as 4.3.0-beta.1 comes before 4.3.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = '', pre] = version.trim().replace(/^v/i, '').split('-', 2);
    const parts = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = left.parts[index] - right.parts[index];
    if (difference) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The installer electron-builder makes for this platform (see `build` in package.json). */
export function pickInstaller(assets: ReleaseAsset[], platform: string, arch: string): string | null {
  const extension = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.dmg' : '.AppImage';
  const installers = assets.filter(
    (asset): asset is { name: string; browser_download_url: string } =>
      typeof asset.name === 'string' &&
      typeof asset.browser_download_url === 'string' &&
      asset.name.endsWith(extension) &&
      asset.browser_download_url.startsWith('https://github.com/')
  );
  const archNames = arch === 'x64' ? ['x64', 'x86_64', 'amd64'] : [arch];
  const forArch = installers.find((asset) => archNames.some((name) => asset.name.includes(name)));
  return (forArch ?? installers[0])?.browser_download_url ?? null;
}

/** Reads GitHub's "latest release" answer; null when it is not a usable release. */
export function readRelease(json: unknown, platform: string, arch: string): AvailableUpdate | null {
  if (!json || typeof json !== 'object') return null;
  const release = json as ReleaseJson;
  if (typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+/.test(release.tag_name)) return null;
  const pageUrl =
    typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/')
      ? release.html_url
      : RELEASES_PAGE;
  const publishedAt = typeof release.published_at === 'string' ? Date.parse(release.published_at) : Number.NaN;
  return {
    version: release.tag_name.replace(/^v/i, ''),
    pageUrl,
    downloadUrl: pickInstaller(Array.isArray(release.assets) ? release.assets : [], platform, arch),
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
  };
}

export async function checkForUpdate({
  currentVersion,
  platform,
  arch,
  fetchImpl = fetch,
  now = Date.now,
}: {
  currentVersion: string;
  platform: string;
  arch: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<UpdateStatus> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Apolloon-Telsysteem/${currentVersion}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { state: 'unreachable', checkedAt: now() };
    const update = readRelease(await response.json(), platform, arch);
    if (!update) return { state: 'unreachable', checkedAt: now() };
    return compareVersions(update.version, currentVersion) > 0
      ? { state: 'available', checkedAt: now(), update, problem: null }
      : { state: 'current', checkedAt: now() };
  } catch {
    return { state: 'unreachable', checkedAt: now() };
  }
}

export function releasePage(version: string): string {
  return `${RELEASES_PAGE}/tag/v${version.replace(/^v/i, '')}`;
}

/**
 * Whether this install can update itself: the Windows installer and an AppImage can,
 * macOS only for signed apps (these are not), and development or unpacked builds have
 * nothing to replace.
 */
export function canInstallInApp({
  isPackaged,
  platform,
  appImage,
}: {
  isPackaged: boolean;
  platform: string;
  appImage: string | undefined;
}): boolean {
  if (!isPackaged) return false;
  return platform === 'win32' || (platform === 'linux' && Boolean(appImage));
}

/** Reads the note left before installing: did the app come back as that version? */
export function installOutcome(noteText: string | null, currentVersion: string): InstallOutcome | null {
  if (!noteText) return null;
  try {
    const { version } = JSON.parse(noteText) as { version?: unknown };
    if (typeof version !== 'string') return null;
    return { version, ok: compareVersions(currentVersion, version) >= 0 };
  } catch {
    return null;
  }
}

/** The updater's cache folder name, from the app-update.yml electron-builder writes. */
export function updaterCacheDirName(appUpdateYml: string | null, fallback: string): string {
  return appUpdateYml?.match(/^updaterCacheDirName:\s*['"]?([\w.-]+)['"]?\s*$/m)?.[1] ?? fallback;
}

/** Only addresses of the releases repository are opened from the update notice. */
export function isReleaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      parsed.pathname.startsWith(`/${RELEASES_REPO}/`)
    );
  } catch {
    return false;
  }
}
