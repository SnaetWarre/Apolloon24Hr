import { LiveDot } from './LiveDot';
import React from 'react';
import { useAppData } from '../app/index';
import { useArrivals } from '../lib/motion';
import { getNextWaitingRunner } from '../lib/runners';
import type { LiveAppSnapshot } from '../types';
import { AvailableNowPanel } from './AvailableNowPanel';
import { KanbanBoard } from './KanbanBoard';
import { LiveDuration } from './LiveTime';
import { PageHeader } from './PageHeader';
import { QueueActions } from './QueueActions';
import { RunnerName } from './RunnerName';
import { RunnerProfileModal } from './RunnerProfileModal';

// Long enough to read a name after the dialog closes, short enough to be gone before the next runner arrives.
const CHECK_IN_NOTICE_MS = 5_000;

const selectQueuePageData = ({ race, runners }: LiveAppSnapshot) => ({
  race,
  runners,
});

export function QueuePage() {
  const { race, runners } = useAppData(selectQueuePageData);
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);
  const [checkedInId, setCheckedInId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!checkedInId) return;
    const timeout = window.setTimeout(() => setCheckedInId(null), CHECK_IN_NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [checkedInId]);

  const checkedIn = runners.find((runner) => runner.id === checkedInId);
  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const waitingCount = runners.filter((runner) => runner.status === 'waiting').length;
  const activeKey = activeRunner?.id ?? 'none';
  const nextKey = nextRunner?.id ?? 'none';
  // Only a change after the page opened moves; the strip is still on load.
  const changed = useArrivals([`active:${activeKey}`, `next:${nextKey}`, `waiting:${waitingCount}`]);
  const moved = (id: string) => (changed.has(id) ? ' value-tick' : '');

  return (
    <>
      <PageHeader
        title="Wachtrij"
        meta={
          checkedIn && (
            <div key={checkedIn.id} className="success-banner" role="status">
              {checkedIn.name} staat bij opwarming.
            </div>
          )
        }
        actions={<QueueActions onOpenProfile={setProfileRunnerId} onCheckedIn={setCheckedInId} />}
      />
      <section className="race-strip" aria-label="Wisselzone">
        <div className="race-strip__now">
          <span className="race-strip__label">
            <LiveDot />
            Nu op de piste
          </span>
          <span key={activeKey} className={`race-strip__runner${moved(`active:${activeKey}`)}`}>
            {activeRunner ? (
              <RunnerName runner={activeRunner} />
            ) : race.raceFinishedAt ? (
              'Race afgelopen'
            ) : race.raceStartedAt ? (
              'Even niemand'
            ) : (
              'Nog niemand gestart'
            )}
          </span>
          {race.activeStartedAt && activeRunner && (
            <LiveDuration
              startedAt={race.activeStartedAt}
              className="race-strip__time"
              refreshMs={1_000}
              format="seconds"
            />
          )}
        </div>
        <div>
          <span className="race-strip__label">Volgende</span>
          <span key={nextKey} className={`race-strip__runner${moved(`next:${nextKey}`)}`}>
            {nextRunner ? <RunnerName runner={nextRunner} /> : 'Niemand klaar'}
          </span>
        </div>
        <div>
          <span className="race-strip__label">Klaar om te lopen</span>
          <span key={waitingCount} className={`race-strip__runner${moved(`waiting:${waitingCount}`)}`}>
            {waitingCount} {waitingCount === 1 ? 'loper' : 'lopers'}
          </span>
        </div>
      </section>
      <KanbanBoard onOpenProfile={setProfileRunnerId} revealRunnerId={checkedInId} />
      <AvailableNowPanel runners={runners} onOpenProfile={setProfileRunnerId} />
      {profileRunnerId && <RunnerProfileModal runnerId={profileRunnerId} onClose={() => setProfileRunnerId(null)} />}
    </>
  );
}
