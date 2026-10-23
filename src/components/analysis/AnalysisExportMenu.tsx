import React from 'react';
import { Icon } from '../Icon';

export function AnalysisExportMenu() {
  const exportRef = React.useRef<HTMLDetailsElement>(null);

  // The export menu closes like any menu: a click elsewhere or Escape.
  React.useEffect(() => {
    const details = exportRef.current;
    if (!details) return;
    const onPointerDown = (event: PointerEvent) => {
      if (details.open && !details.contains(event.target as Node)) details.open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (details.open && event.key === 'Escape') details.open = false;
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <details ref={exportRef} className="analysis-export">
      <summary className="btn btn--sm">
        <Icon name="download" size={14} />
        Exporteren
      </summary>
      <div className="analysis-export__menu">
        <p>Exports bevatten altijd de volledige wedstrijd. De labelfilters op dit scherm tellen niet mee.</p>
        <a className="btn btn--sm" href="/api/export/race.xlsx" download>
          Excel: lopers, punten en rondes
        </a>
        <p className="analysis-export__group">Voor MATLAB, R of andere scripts</p>
        <a className="btn btn--quiet btn--sm" href="/api/export/laps.csv" download>
          Rondes (CSV)
        </a>
        <a className="btn btn--quiet btn--sm" href="/api/export/laps.json" download>
          Rondes (JSON)
        </a>
        <a className="btn btn--quiet btn--sm" href="/api/export/current-state.json" download>
          Volledige toestand (JSON)
        </a>
        <a className="btn btn--quiet btn--sm" href="/api/export/events.csv" download>
          Gebeurtenissen (CSV)
        </a>
        <a className="btn btn--quiet btn--sm" href="/api/export/events.json" download>
          Gebeurtenissen (JSON)
        </a>
      </div>
    </details>
  );
}
