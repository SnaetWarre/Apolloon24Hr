import React from 'react';
import { useAppData, useRaceHistory } from '../../app/index';
import { isFastestLapForRecordMode, publicRecordModeTitle } from '../../lib/analysis';
import { observeDisplayHistory } from '../../lib/displayHistory';
import { useArrivals } from '../../lib/motion';
import { getNextWaitingRunner, lapRunnerLabel } from '../../lib/runners';
import { formatDurationMs } from '../../lib/time';
import type { Label, LapRecord, LiveAppSnapshot, PublicRecordMode, RaceEvent, Runner } from '../../types';
import { LabelBadge } from '../LabelBadge';
import { LiveDot } from '../LiveDot';
import { DisplayBrand } from './displayParts';
import { useDisplayPresentation } from './displaySettings';

const OUTSIDE_ALERT_VISIBLE_MS = 8_000;
const selectOutsideDisplayData = ({ runners, race, settings }: LiveAppSnapshot) => ({
  runners,
  race,
  settings,
});

export function OutsideDisplay() {
  const { runners, race, settings } = useAppData(selectOutsideDisplayData);
  const { laps, events, initialized: historyIsInitialized } = useRaceHistory({ scope: 'full' });
  const finished = Boolean(race.raceFinishedAt);
  const activeRunner = finished ? null : runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = finished ? null : getNextWaitingRunner(runners);
  const [recordLap, setRecordLap] = React.useState<LapRecord | null>(null);
  const [burgieEvent, setBurgieEvent] = React.useState<RaceEvent | null>(null);
  const knownLapIdsRef = React.useRef<Set<string> | null>(null);
  const knownEventIdsRef = React.useRef<Set<string> | null>(null);
  const recordTimeoutRef = React.useRef<number | null>(null);
  const burgieTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const latestLap = laps[0] || null;
    const lapHistoryObservation = observeDisplayHistory(
      historyIsInitialized,
      knownLapIdsRef.current,
      laps.map((lap) => lap.id),
      latestLap?.id || null
    );
    if (!lapHistoryObservation) return;
    knownLapIdsRef.current = lapHistoryObservation.knownIds;

    if (settings.publicRecordMode === 'off') {
      setRecordLap(null);
    }

    if (
      !burgieEvent &&
      latestLap &&
      lapHistoryObservation.shouldAnnounceLatest &&
      isFastestLapForRecordMode(latestLap, laps.slice(1), race, settings.publicRecordMode)
    ) {
      setRecordLap(latestLap);
      if (recordTimeoutRef.current !== null) {
        window.clearTimeout(recordTimeoutRef.current);
      }
      recordTimeoutRef.current = window.setTimeout(() => {
        setRecordLap(null);
        recordTimeoutRef.current = null;
      }, OUTSIDE_ALERT_VISIBLE_MS);
    }

    setRecordLap((currentRecordLap) => {
      if (!currentRecordLap) return currentRecordLap;
      return laps.some((lap) => lap.id === currentRecordLap.id) ? currentRecordLap : null;
    });
  }, [burgieEvent, historyIsInitialized, laps, race, settings.publicRecordMode]);

  React.useEffect(() => {
    const latestBurgieEvent = events.find((event) => event.type === 'burgie_gepakt') || null;
    const eventHistoryObservation = observeDisplayHistory(
      historyIsInitialized,
      knownEventIdsRef.current,
      events.map((event) => event.id),
      latestBurgieEvent?.id || null
    );
    if (!eventHistoryObservation) return;
    knownEventIdsRef.current = eventHistoryObservation.knownIds;

    if (latestBurgieEvent && eventHistoryObservation.shouldAnnounceLatest) {
      setRecordLap(null);
      if (recordTimeoutRef.current !== null) {
        window.clearTimeout(recordTimeoutRef.current);
        recordTimeoutRef.current = null;
      }
      setBurgieEvent(latestBurgieEvent);
      if (burgieTimeoutRef.current !== null) {
        window.clearTimeout(burgieTimeoutRef.current);
      }
      burgieTimeoutRef.current = window.setTimeout(() => {
        setBurgieEvent(null);
        burgieTimeoutRef.current = null;
      }, OUTSIDE_ALERT_VISIBLE_MS);
    }
  }, [events, historyIsInitialized]);

  React.useEffect(() => {
    return () => {
      if (recordTimeoutRef.current !== null) {
        window.clearTimeout(recordTimeoutRef.current);
      }
      if (burgieTimeoutRef.current !== null) {
        window.clearTimeout(burgieTimeoutRef.current);
      }
    };
  }, []);

  const [presentation] = useDisplayPresentation('outside', 'light');
  const activeKey = activeRunner?.id ?? 'none';
  const nextKey = nextRunner?.id ?? 'none';
  // A runner who takes over after the screen opened rises in; the first one is simply there.
  const changed = useArrivals([`active:${activeKey}`, `next:${nextKey}`]);

  return (
    <main className={`display-root display-root--outside display-root--${presentation}`}>
      <DisplayBrand />
      <section className="outside-band outside-band--current">
        {!finished && (
          <span className="display-kicker">
            <LiveDot />
            Nu op de piste
          </span>
        )}
        <div
          key={activeKey}
          className={`outside-runner${changed.has(`active:${activeKey}`) ? ' outside-runner--in' : ''}`}
        >
          {finished ? (
            <strong className="display-runner-name">Race afgelopen</strong>
          ) : (
            <DisplayRunner runner={activeRunner} empty={race.raceStartedAt ? 'Even niemand' : 'Nog niemand gestart'} />
          )}
        </div>
      </section>
      <section className="outside-band outside-band--next">
        {!finished && <span className="display-kicker">Volgende racer</span>}
        <div key={nextKey} className={`outside-runner${changed.has(`next:${nextKey}`) ? ' outside-runner--in' : ''}`}>
          <DisplayRunner
            runner={nextRunner}
            empty={finished ? 'Bedankt aan alle lopers' : 'Geen loper in de wachtrij'}
          />
        </div>
      </section>
      {burgieEvent ? (
        <OutsideBurgieFlash key={burgieEvent.id} event={burgieEvent} />
      ) : recordLap ? (
        <OutsideRecordFlash key={recordLap.id} lap={recordLap} mode={settings.publicRecordMode} />
      ) : null}
    </main>
  );
}

// Steps a long name down until every word fits on a line and the name fits in two lines.
// "Marie-Christine Van den Broeck-Vandevelde" was cut to "Van den…" at full size.
const RUNNER_NAME_SCALES = [1, 0.85, 0.68, 0.6, 0.5];

function DisplayRunner({ runner, empty }: { runner: Runner | null; empty: string }) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const name = runner?.name;
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const nameNode = row?.querySelector<HTMLElement>('.display-runner-name');
    if (!row || !nameNode) return;
    const fit = () => {
      // Without breaking inside words, a word that is too wide shows up as horizontal overflow.
      nameNode.style.overflowWrap = 'normal';
      for (const scale of RUNNER_NAME_SCALES) {
        row.style.setProperty('--runner-name-scale', String(scale));
        const lineHeight = parseFloat(getComputedStyle(nameNode).fontSize);
        const hiddenHeight = nameNode.scrollHeight - nameNode.clientHeight;
        if (nameNode.scrollWidth <= nameNode.clientWidth && hiddenHeight < lineHeight / 2) break;
      }
      nameNode.style.overflowWrap = '';
    };
    fit();
    let mounted = true;
    // Geist swaps in after the first paint and is wider than the fallback font.
    void document.fonts.ready.then(() => mounted && fit());
    window.addEventListener('resize', fit);
    return () => {
      mounted = false;
      window.removeEventListener('resize', fit);
    };
  }, [name]);
  if (!runner) return <strong className="display-runner-name display-runner-name--empty">{empty}</strong>;
  return (
    <>
      <div ref={rowRef} className="display-runner">
        {runner.runnerNumber && <span className="display-bib">{runner.runnerNumber}</span>}
        <strong className="display-runner-name">{runner.name}</strong>
      </div>
      <DisplayLabels labels={runner.labels} />
    </>
  );
}

// Only zusterverenigingen show outside; other labels (like speedteams) stay private.
function DisplayLabels({ labels }: { labels: Label[] }) {
  const shown = labels.filter((label) => label.kind === 'zustervereniging' || label.kind === 'association');
  if (!shown.length) return null;
  return (
    <div className="display-labels">
      {shown.map((label) => (
        <LabelBadge key={label.id} label={label} />
      ))}
    </div>
  );
}

// The flash fades in, holds, and fades out just before it is removed.
const flashStyle = { '--flash-ms': `${OUTSIDE_ALERT_VISIBLE_MS}ms` } as React.CSSProperties;
// Longer titles get a smaller size so they stay on two lines.
const LONG_FLASH_TITLE = 18;

function OutsideRecordFlash({ lap, mode }: { lap: LapRecord; mode: PublicRecordMode }) {
  return (
    <section className="outside-record-flash" style={flashStyle} aria-live="polite">
      <div
        className={`record-flash-content${publicRecordModeTitle(mode).length > LONG_FLASH_TITLE ? ' record-flash-content--long' : ''}`}
      >
        <span>{publicRecordModeTitle(mode)}</span>
        <strong>{formatDurationMs(lap.durationMs)}</strong>
        <em>{lapRunnerLabel(lap)}</em>
      </div>
    </section>
  );
}

function OutsideBurgieFlash({ event }: { event: RaceEvent }) {
  return (
    <section className="outside-record-flash" style={flashStyle} aria-live="polite">
      <div className="record-flash-content">
        <span>Burgie gepakt</span>
        <strong>ZINGEN</strong>
        <em>{eventRunnerLabel(event)}</em>
      </div>
    </section>
  );
}

function eventRunnerLabel(event: RaceEvent) {
  if (!event.runnerName) return 'Publiek moment';
  return lapRunnerLabel({ runnerNumber: event.runnerNumber, runnerName: event.runnerName });
}
