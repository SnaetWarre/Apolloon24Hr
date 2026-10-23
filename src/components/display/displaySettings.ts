import React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { MAX_ZOOM, MIN_ZOOM, nextZoom, useZoomKeys } from '../../lib/zoom';
import type { Label } from '../../types';

export type DisplayPresentation = 'light' | 'dark';
type DisplayName = 'inside' | 'outside' | 'competitions';

/**
 * Displays keep their own presentation, independent of the operator theme.
 * `?thema=licht|donker` in the address, then the choice made on this display,
 * then the default for the screen.
 */
export function useDisplayPresentation(
  display: DisplayName,
  defaultPresentation: DisplayPresentation
): [DisplayPresentation, (next: DisplayPresentation) => void] {
  const [value, setValue] = useDisplaySetting(display, 'thema');
  // Older versions stored 'light' and 'dark'.
  const presentation =
    value === 'licht' || value === 'light'
      ? 'light'
      : value === 'donker' || value === 'dark'
        ? 'dark'
        : defaultPresentation;
  React.useLayoutEffect(() => {
    document.documentElement.dataset.displayTone = presentation;
  }, [presentation]);
  return [presentation, (next) => setValue(next === 'light' ? 'licht' : 'donker')];
}

/**
 * Ctrl +, Ctrl − and Ctrl 0 zoom a display, kept as `?zoom=125` (percent) like its other
 * choices. 100% is the normal size and leaves the address alone. The zoom goes on the
 * display's root as --display-zoom; displays.css keeps the page the size of the screen.
 */
export function useDisplayZoom(display: DisplayName): React.CSSProperties {
  const [value, setValue] = useDisplaySetting(display, 'zoom');
  const percent = Number(value);
  const zoom = percent >= MIN_ZOOM * 100 && percent <= MAX_ZOOM * 100 ? percent / 100 : 1;
  useZoomKeys((step) => {
    const next = nextZoom(zoom, step);
    setValue(next === 1 ? null : String(Math.round(next * 100)));
  });
  return { '--display-zoom': zoom } as React.CSSProperties;
}

export const MAX_COMPETITIONS = 6;

/** The same teams give the same key, whatever order they were picked in. */
export function competitionKey(teams: Array<{ id: string }>) {
  return teams
    .map((team) => team.id)
    .sort()
    .join('.');
}

/**
 * The competitions on the Competitiescherm, as `?competities=id.id.id,id.id`.
 * A label that was deleted drops out, and so does a competition left with one team.
 */
export function useDisplayCompetitions(labels: Label[]): [Label[][], (next: Label[][]) => void] {
  const [value, setValue] = useDisplaySetting('competitions', 'competities');
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const competitions = (value ?? '')
    .split(',')
    .map((competition) => [...new Set(competition.split('.').flatMap((id) => labelsById.get(id) ?? []))])
    .filter((teams) => teams.length >= 2)
    .filter((teams, index, all) => all.findIndex((other) => competitionKey(other) === competitionKey(teams)) === index)
    .slice(0, MAX_COMPETITIONS);
  return [
    competitions,
    (next) => setValue(next.length ? next.map((teams) => teams.map((team) => team.id).join('.')).join(',') : null),
  ];
}

/**
 * A choice made on one display. The address wins, then what this browser remembers.
 * The choice always goes into the address too: failover reopens the same address
 * on another laptop, whose browser storage is empty.
 */
function useDisplaySetting(display: DisplayName, param: string): [string | null, (next: string | null) => void] {
  const storageKey = param === 'thema' ? `apolloon.display.${display}` : `apolloon.display.${display}.${param}`;
  const navigate = useNavigate();
  // The router reads `?zoom=125` as a number, and quotes a string that looks like one.
  const requestedValue = useRouterState({
    select: (state) => (state.location.search as Record<string, unknown>)[param],
  });
  const requested = requestedValue == null ? null : String(requestedValue);
  const [stored, setStored] = React.useState<string | null>(() => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const writeAddress = React.useCallback(
    (next: string | null) =>
      void navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => ({ ...previous, [param]: next ?? undefined }),
        replace: true,
      }),
    [navigate, param]
  );
  const choose = React.useCallback(
    (next: string | null) => {
      try {
        if (next === null) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, next);
      } catch {
        // Keep the choice for this session only.
      }
      setStored(next);
      writeAddress(next);
    },
    [storageKey, writeAddress]
  );
  React.useEffect(() => {
    if (requested === null && stored !== null) writeAddress(stored);
  }, [requested, stored, writeAddress]);
  return [requested ?? stored, choose];
}
