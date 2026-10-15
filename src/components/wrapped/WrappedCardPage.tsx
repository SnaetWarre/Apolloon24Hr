import React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useWrapped } from './useWrapped';
import { WrappedCard } from './WrappedCard';

/**
 * /wrapped/card?runner=<id>: the card alone at its real size, without the app around it.
 * The desktop app opens this in a hidden window and saves it as a PNG once the page sets
 * data-wrapped-ready on <html>, after the fonts and logos have loaded.
 */
export function WrappedCardPage() {
  const runnerId = useRouterState({
    select: (state) => (state.location.search as { runner?: string }).runner ?? null,
  });
  const { wrapped, ready } = useWrapped();
  const runner = ready ? wrapped.find((entry) => entry.runnerId === runnerId) : undefined;

  React.useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    let active = true;
    void Promise.all([
      document.fonts.ready,
      ...[...document.images].map((image) => image.decode().catch(() => {})),
    ]).then(() => {
      if (active) root.dataset.wrappedReady = runner ? 'card' : 'missing';
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
      <WrappedCard runner={runner} />
    </div>
  );
}
