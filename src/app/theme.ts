import React from 'react';

// Operator theme preference. Stored per browser (laptop), never synchronised as a race setting.
// index.html applies the same logic before first paint; keep the key and values in sync.
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'apolloon.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set<() => void>();
let preference: ThemePreference = readStoredPreference();
let systemDark = typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
let listening = false;

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage can be blocked (private mode); fall back to the operating system.
  }
  return 'system';
}

export function resolveTheme(value: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (value === 'system') return prefersDark ? 'dark' : 'light';
  return value;
}

function apply(): void {
  const root = document.documentElement;
  const resolved = resolveTheme(preference, systemDark);
  root.dataset.themePreference = preference;
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
  window.matchMedia(DARK_QUERY).addEventListener('change', (event) => {
    systemDark = event.matches;
    notify();
  });
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
  return resolveTheme(preference, systemDark);
}

function subscribe(listener: () => void): () => void {
  ensureListening();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return React.useSyncExternalStore(subscribe, () => preference, () => 'system');
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
