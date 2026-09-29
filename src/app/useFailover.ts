import React from 'react';

const MEMBERS_KEY = 'apolloon.cluster-members';
const SWITCH_AFTER_MS = 8_000;
const RETRY_MS = 3_000;

/** The Electron app talks to its own laptop's server, which Electron restarts; it never switches. */
function isOwnLaptop(): boolean {
  return /\bElectron\//.test(window.navigator.userAgent);
}

function rememberedMembers(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(MEMBERS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === 'string') : [];
  } catch {
    return [];
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    // An opaque answer is enough: it proves an Apolloon server is listening there.
    await fetch(`${url}/api/host-info`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Browsers remember the other Apolloon laptops. When theirs stays
 * unreachable, they reopen the same page on the first laptop that answers.
 * Returns true while it is looking for one.
 */
export function useFailover(disconnected: boolean): boolean {
  const [switching, setSwitching] = React.useState(false);

  React.useEffect(() => {
    if (isOwnLaptop() || disconnected) return undefined;
    const remember = async () => {
      try {
        const response = await fetch('/api/cluster/status', { cache: 'no-store' });
        if (!response.ok) return;
        const { memberUrls } = (await response.json()) as { memberUrls?: string[] };
        window.localStorage.setItem(MEMBERS_KEY, JSON.stringify(memberUrls ?? []));
      } catch {
        // Keep the list from the last successful check.
      }
    };
    void remember();
    const interval = window.setInterval(() => void remember(), 60_000);
    return () => window.clearInterval(interval);
  }, [disconnected]);

  React.useEffect(() => {
    if (isOwnLaptop() || !disconnected) return undefined;
    let cancelled = false;
    const search = async () => {
      setSwitching(true);
      while (!cancelled) {
        for (const url of rememberedMembers().filter((member) => member !== window.location.origin)) {
          if (cancelled) return;
          if (await answers(url)) {
            window.location.assign(`${url}${window.location.pathname}${window.location.search}`);
            return;
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS));
      }
    };
    const timer = window.setTimeout(() => void search(), SWITCH_AFTER_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setSwitching(false);
    };
  }, [disconnected]);

  return switching;
}
