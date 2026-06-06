export async function fetchState<T = unknown>(): Promise<T> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error('state fetch failed');
  return (await res.json()) as T;
}
