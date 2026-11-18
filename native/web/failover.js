// A browser reloads its current screen on a surviving laptop. It never forwards writes across origins.
export function followGroup() {
  let group = null;
  let lostAt = null;
  const ask = async (origin) => {
    try {
      const response = await fetch(origin + '/api/cluster/status', {
        cache: 'no-store',
        signal: AbortSignal.timeout(1000),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  async function check() {
    const current = await ask(location.origin);
    if (current) {
      group = current;
      lostAt = null;
    } else if (typeof group?.clusterId === 'string' && Array.isArray(group.memberUrls) && group.memberUrls.length) {
      lostAt ??= performance.now();
      const elapsed = performance.now() - lostAt;
      if (elapsed >= 2000) {
        const candidates = group.memberUrls.flatMap((raw) => {
          try {
            const url = new URL(raw);
            return ['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin ? [url.origin] : [];
          } catch {
            return [];
          }
        });
        const answers = await Promise.all(candidates.map(async (url) => ({ url, status: await ask(url) })));
        const peers = answers.filter(({ status }) => status?.clusterId === group.clusterId);
        const confirmed = peers.find(
          ({ status }) =>
            status.writable && status.members?.some((member) => member.hostId === group.hostId && !member.reachable)
        );
        const target =
          confirmed ?? (elapsed >= 8000 ? (peers.find(({ status }) => status.writable) ?? peers[0]) : undefined);
        if (target && !(await ask(location.origin))) {
          location.assign(target.url + location.pathname + location.search + location.hash);
          return;
        }
      }
    }
    setTimeout(check, 500);
  }
  void check();
}
