import React from 'react';

// Operator theme: Licht or Donker. Stored per browser (laptop), never synchronised as a race setting.
// Without a stored choice the first load follows the operating system once.
// index.html applies the same logic before first paint; keep the key and values in sync.
export type ThemePreference = 'light' | 'dark';
export type ResolvedTheme = ThemePreference;

export const THEME_STORAGE_KEY = 'apolloon.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set<() => void>();
let preference: ThemePreference = readStoredPreference();
let listening = false;

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage can be blocked (private mode); fall back to the operating system.
  }
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function apply(): void {
  const root = document.documentElement;
  const resolved = preference;
  // Public displays own their presentation; they ignore the operator theme.
  if (root.dataset.surface === 'display') return;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

function notify(): void {
  apply();
  listeners.forEach((listener) => listener());
}

function ensureListening(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // Another tab on the same laptop changed the preference.
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    preference = readStoredPreference();
    notify();
  });
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Keep the in-memory choice for this session.
  }
  notify();
}

export function getResolvedTheme(): ResolvedTheme {
  return preference;
}

function subscribe(listener: () => void): () => void {
  ensureListening();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return React.useSyncExternalStore(subscribe, () => preference, () => 'light');
}

export function useResolvedTheme(): ResolvedTheme {
  return React.useSyncExternalStore(subscribe, getResolvedTheme, () => 'light');
}

/** Marks the document as an operator or display surface and keeps data-theme correct. */
export function setDocumentSurface(surface: 'operator' | 'display'): void {
  const root = document.documentElement;
  if (surface === 'display') {
    root.dataset.surface = 'display';
    delete root.dataset.theme;
    root.style.colorScheme = '';
  } else {
    delete root.dataset.surface;
    delete root.dataset.displayTone;
    apply();
  }
}
