export async function login(password: string): Promise<boolean> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'include',
  });
  return res.ok;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
}

export async function fetchState<T = unknown>(): Promise<T> {
  const res = await fetch('/api/state', { credentials: 'include' });
  if (!res.ok) throw new Error('unauthorized');
  return (await res.json()) as T;
}


