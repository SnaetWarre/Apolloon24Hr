/**
 * Looks up the newest published version. The source repository is private, so every
 * release is copied to a public one (.github/workflows/publish-public-release.yml),
 * which the app reads without a token and links to for the download.
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
  | { state: 'available'; checkedAt: number; update: AvailableUpdate }
  /** No internet, which is normal at the event, or the release source did not answer. */
  | { state: 'unreachable'; checkedAt: number };

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
      ? { state: 'available', checkedAt: now(), update }
      : { state: 'current', checkedAt: now() };
  } catch {
    return { state: 'unreachable', checkedAt: now() };
  }
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
