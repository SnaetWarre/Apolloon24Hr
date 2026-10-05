import React from 'react';

const MEMBERS_KEY = 'apolloon.cluster-members';
const HOST_KEY = 'apolloon.cluster-host';
/** How long a screen's laptop must stay unreachable before the others' word moves it; shorter blips never do. */
const CONFIRM_MS = 2_000;
/** Without the others' word (too few laptops left, or they still reach it), a screen moves after this long. */
const SWITCH_ANYWAY_MS = 8_000;
const CHECK_EVERY_MS = 500;
const ANSWER_TIMEOUT_MS = 1_000;

/** What another laptop says about the group, as far as moving a screen goes. */
export type GroupAnswer = {
  url: string;
  status: { writable: boolean; members: Array<{ hostId: string; reachable: boolean }> } | null;
};

/**
 * Where a screen whose laptop has not answered for `downForMs` should go, or
 * null to wait. It goes early only when its own laptop still does not answer
 * and a laptop of the group, which has a working leader, says it lost that
 * laptop too: then it is gone, not a blip between this screen and it.
 */
export function chooseLaptop(
  answers: GroupAnswer[],
  ownHostId: string | null,
  ownAnswers: boolean,
  downForMs: number
): string | null {
  const answering = answers.filter((answer) => answer.status);
  if (downForMs >= CONFIRM_MS && ownHostId && !ownAnswers) {
    const lostIt = answering.find(
      ({ status }) =>
        status?.writable && status.members.some((member) => member.hostId === ownHostId && !member.reachable)
    );
    if (lostIt) return lostIt.url;
  }
  if (downForMs >= SWITCH_ANYWAY_MS)
    return (answering.find(({ status }) => status?.writable) ?? answering[0])?.url ?? null;
  return null;
}

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

async function ask(url: string): Promise<GroupAnswer> {
  try {
    const response = await fetch(`${url}/api/cluster/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
    return { url, status: response.ok ? ((await response.json()) as GroupAnswer['status']) : null };
  } catch {
    return { url, status: null };
  }
}

async function ownLaptopAnswers(): Promise<boolean> {
  try {
    return (await fetch('/api/host-info', { cache: 'no-store', signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/**
 * Browsers remember the other Apolloon laptops. When theirs stops answering
 * and the others lost it too, or it stays unreachable, they reopen the same
 * page on another laptop. Returns true while it is looking for one.
 */
export function useFailover(disconnected: boolean): boolean {
  const [switching, setSwitching] = React.useState(false);

  React.useEffect(() => {
    if (isOwnLaptop() || disconnected) return undefined;
    const remember = async () => {
      try {
        const response = await fetch('/api/cluster/status', { cache: 'no-store' });
        if (!response.ok) return;
        const { hostId, memberUrls } = (await response.json()) as { hostId?: string; memberUrls?: string[] };
        window.localStorage.setItem(MEMBERS_KEY, JSON.stringify(memberUrls ?? []));
        if (hostId) window.localStorage.setItem(HOST_KEY, hostId);
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
    const lostAt = performance.now();
    // A check starts every half second, without waiting for a laptop that does not answer to time out.
    const check = async () => {
      const others = rememberedMembers().filter((member) => member !== window.location.origin);
      const [ownAnswers, ...answers] = await Promise.all([ownLaptopAnswers(), ...others.map(ask)]);
      if (cancelled) return;
      const downForMs = performance.now() - lostAt;
      if (downForMs >= CONFIRM_MS) setSwitching(true);
      const target = chooseLaptop(answers, window.localStorage.getItem(HOST_KEY), ownAnswers, downForMs);
      if (!target) return;
      cancelled = true;
      window.location.assign(`${target}${window.location.pathname}${window.location.search}`);
    };
    void check();
    const interval = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      setSwitching(false);
    };
  }, [disconnected]);

  return switching;
}
