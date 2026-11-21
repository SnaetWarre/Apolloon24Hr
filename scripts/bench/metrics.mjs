export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 100) / 100 : null;
}

export function displayedHandoff(screen, frame) {
  if (screen === '/queue') {
    const next = frame.text.match(/Bench (\d+)/)?.[1];
    return next === undefined ? null : Number(next) - 2;
  }
  if (screen === '/display/outside') {
    const active = frame.text.match(/Bench (\d+)/)?.[1];
    return active === undefined ? null : Number(active) - 1;
  }
  const totals = frame.text
    .split('|')
    .map((s) => Number(s.replaceAll(/[.\s]/g, '')))
    .filter((n) => n >= 2240 && n <= 2270);
  return totals.length ? Math.max(...totals) - 2241 : null;
}

export function browserLatencies(screen, frames, writes) {
  return writes.map((write) => {
    const frame = frames.find((f) => {
      const index = displayedHandoff(screen, f);
      return f.at >= write.sentAt && index !== null && index >= write.i;
    });
    return frame ? frame.at - write.sentAt : null;
  });
}

export function nativeLatencies(events, writes, endAt) {
  return writes.map((write, i) => {
    const next = writes[i + 1]?.sentAt ?? endAt;
    const changes = events.filter((e) => e.hash && e.at >= write.sentAt && e.at < next);
    return changes.length === 1 ? changes[0].at - write.sentAt : null;
  });
}

export function validateReplicaLaps(histories, initialIds, expectedAdded) {
  const initial = new Set(initialIds);
  let added;
  for (const history of histories) {
    const ids = history.laps.map((lap) => lap.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length || ids.length !== initial.size + expectedAdded) return null;
    if (initialIds.some((id) => !unique.has(id))) return null;
    const current = ids.filter((id) => !initial.has(id)).sort();
    if (added && JSON.stringify(current) !== JSON.stringify(added)) return null;
    added = current;
  }
  return histories.length ? added : null;
}
