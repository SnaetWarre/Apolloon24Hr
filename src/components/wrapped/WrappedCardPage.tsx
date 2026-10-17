import React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useWrapped } from './useWrapped';
import { WrappedStory } from './WrappedStory';

/**
 * /wrapped/card?runner=<id>: the runner's story pages at their real size, under each other,
 * without the app around them. The Wrapped script saves each page as a PNG once this page
 * sets data-wrapped-ready on <html>, after the fonts have loaded and long text was fitted.
 */
export function WrappedCardPage() {
  const runnerId = useRouterState({
    select: (state) => (state.location.search as { runner?: string }).runner ?? null,
  });
  const { wrapped, ready, race } = useWrapped();
  const runner = ready ? wrapped.find((entry) => entry.runnerId === runnerId) : undefined;

  React.useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    let active = true;
    const text = document.body.textContent ?? '';
    const fonts = ['100px "Bebas Neue"', '100px "Racing Sans One"', 'bold 100px "League Spartan 2014"'];
    void Promise.all(fonts.map((font) => document.fonts.load(font, text))).then(() => {
      if (!active) return;
      for (const text of document.querySelectorAll<SVGTextElement>('text[data-fit]')) {
        const width = text.getComputedTextLength();
        const fit = Number(text.dataset.fit);
        if (width > fit) text.setAttribute('font-size', String((Number(text.getAttribute('font-size')) * fit) / width));
      }
      root.dataset.wrappedReady = runner ? 'card' : 'missing';
    });
    return () => {
      active = false;
      delete root.dataset.wrappedReady;
    };
  }, [ready, runner]);

  if (!ready) return null;
  if (!runner) return <p className="wrapped-missing">Geen loper met rondes gevonden voor deze kaart.</p>;
  return (
    <div className="wrapped-page">
      <WrappedStory
        runner={runner}
        year={new Date(race.raceFinishedAt ?? race.raceStartedAt ?? Date.now()).getFullYear()}
        raceStartedAt={race.raceStartedAt}
      />
    </div>
  );
}
