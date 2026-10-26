import React from 'react';
import { useAppActions, useAppData, useRaceHistory } from '../../app/index';
import { competitionKey, MAX_COMPETITIONS } from '../../../shared/competitions';
import { useArrivals } from '../../lib/motion';
import { buildRunnerRanking } from '../../lib/ranking';
import { lapRunnerLabel } from '../../lib/runners';
import { formatDurationMs } from '../../lib/time';
import type { Label, LapRecord, LiveAppSnapshot } from '../../types';
import { Icon } from '../Icon';
import { CompetitionPicker } from './CompetitionPicker';
import { DisplayBrand, DisplayTotals, PresentationSwitch } from './displayParts';
import { useDisplayPresentation, useDisplayZoom } from './displaySettings';

// The runners on the Competities screen.
const COMPETITION_RANKING_LENGTH = 20;

const selectCompetitionDisplayData = ({ runners, labels, race, settings }: LiveAppSnapshot) => ({
  runners,
  labels,
  race,
  competitions: settings.competitions,
});

export function CompetitionDisplay() {
  const { runners, labels, race, competitions: competitionIds } = useAppData(selectCompetitionDisplayData);
  const { addCompetition, removeCompetition } = useAppActions();
  const [presentation, setPresentation] = useDisplayPresentation('competitions', 'dark');
  const zoomStyle = useDisplayZoom('competitions');
  // The server keeps them, so every laptop in the group shows the same competitions.
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const competitions = competitionIds
    .map((ids) => ({ key: competitionKey(ids), ids, teams: ids.flatMap((id) => labelsById.get(id) ?? []) }))
    .filter(({ teams }) => teams.length >= 2);
  const [picking, setPicking] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const { laps } = useRaceHistory({ scope: 'full' });
  const lapsByLabel = countLapsByLabel(laps);
  const ranking = buildRunnerRanking(runners, laps, 'laps', null).slice(0, COMPETITION_RANKING_LENGTH);
  const canAdd = competitions.length < MAX_COMPETITIONS && labels.length >= 2;

  return (
    <main className={`display-root display-root--competitions display-root--${presentation}`} style={zoomStyle}>
      <header className="inside-header">
        <DisplayBrand />
        <h1 className="competitions-title">Competities</h1>
        <DisplayTotals race={race} laps={laps} />
      </header>

      <div className="competitions-board">
        {competitions.length ? (
          <div
            className="competitions-list"
            // Each competition gets height for its teams plus its title.
            style={{
              gridTemplateRows: competitions.map(({ teams }) => `minmax(0, ${teams.length + 1.4}fr)`).join(' '),
            }}
          >
            {competitions.map(({ key, ids, teams }) => (
              <CompetitionBars
                key={key}
                teams={teams}
                lapsByLabel={lapsByLabel}
                onRemove={() => void removeCompetition(ids).catch(() => undefined)}
              />
            ))}
          </div>
        ) : (
          <div className="competitions-empty">
            <p>Kies welke ploegen tegen elkaar strijden, bijvoorbeeld 1ste, 2de en 3de jaar.</p>
            <button
              type="button"
              className="competitions-empty__add"
              onClick={() => setPicking(true)}
              disabled={!canAdd}
            >
              <Icon name="plus" size={20} />
              Competitie toevoegen
            </button>
            {labels.length < 2 && <p>Maak eerst minstens twee labels in Beheer › Labels.</p>}
          </div>
        )}

        <section className="display-panel laps-ranking" aria-label="Ranking op meeste rondes">
          <div className="inside-panel-heading">
            <h2>Meeste rondes</h2>
          </div>
          <p className="laps-ranking__help">Bij gelijke stand telt het snelste gemiddelde.</p>
          {ranking.length ? (
            <ol className="laps-ranking__list">
              {ranking.map((runner, index) => (
                <li key={runner.runnerId} className="laps-ranking__row">
                  <span>{index + 1}</span>
                  <strong>{lapRunnerLabel(runner)}</strong>
                  <em>
                    {runner.lapCount}
                    <small> gem. {formatDurationMs(runner.averageLapMs)}</small>
                  </em>
                </li>
              ))}
            </ol>
          ) : (
            <div className="inside-empty">Nog geen rondes.</div>
          )}
        </section>
      </div>

      <footer className="display-controls">
        {competitions.length > 0 && (
          <button
            type="button"
            className="inside-control-button"
            onClick={() => setPicking(true)}
            disabled={!canAdd}
            title={canAdd ? undefined : `Er passen ${MAX_COMPETITIONS} competities op dit scherm`}
          >
            Competitie toevoegen
          </button>
        )}
        <PresentationSwitch presentation={presentation} onChange={setPresentation} />
      </footer>

      {picking && (
        <CompetitionPicker
          labels={labels}
          taken={new Set(competitions.map(({ key }) => key))}
          error={addError}
          onCancel={() => {
            setPicking(false);
            setAddError(null);
          }}
          onAdd={(teams) =>
            addCompetition(teams.map((team) => team.id)).then(
              () => {
                setPicking(false);
                setAddError(null);
              },
              (error: unknown) => setAddError(error instanceof Error ? error.message : 'Toevoegen mislukt')
            )
          }
        />
      )}
    </main>
  );
}

/**
 * One competition as a bar chart: a thick bar per team, leader on top, its laps at the
 * end of the bar and how far it trails the leader. A team that overtakes another
 * slides to its new place, so the room sees the overtake.
 */
function CompetitionBars({
  teams,
  lapsByLabel,
  onRemove,
}: {
  teams: Label[];
  lapsByLabel: Map<string, number>;
  onRemove: () => void;
}) {
  const standings = teams
    .map((label) => ({ label, laps: lapsByLabel.get(label.id) ?? 0 }))
    .sort((first, second) => second.laps - first.laps || first.label.name.localeCompare(second.label.name, 'nl-BE'));
  const leaderLaps = standings[0].laps;
  const title = teams.map((team) => team.name).join(' vs ');
  const changed = useArrivals(standings.map(({ label, laps }) => `${label.id}:${laps}`));
  const listRef = React.useRef<HTMLOListElement>(null);
  // Places, not pixels: a competition added or removed elsewhere resizes the rows,
  // and that must not look like an overtake.
  const rowPlaces = React.useRef(new Map<string, number>());
  React.useLayoutEffect(() => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-label-id]') ?? [];
    for (const [place, row] of rows.entries()) {
      const id = row.dataset.labelId ?? '';
      const last = rowPlaces.current.get(id);
      rowPlaces.current.set(id, place);
      if (last === undefined || last === place) continue;
      row.style.animation = 'none';
      void row.offsetHeight;
      row.style.setProperty('--slide-from', `${(last - place) * row.offsetHeight}px`);
      row.style.animation = 'slide-from var(--dur-3) var(--ease-out)';
    }
  });

  return (
    <section
      className="competition"
      aria-label={title}
      style={
        {
          '--teams': teams.length,
          // The bars leave room for the widest figure after them.
          '--digits': leaderLaps.toLocaleString('nl-BE').length,
        } as React.CSSProperties
      }
    >
      <div className="competition__head">
        <h2>{title}</h2>
        <p>{competitionVerdict(standings)}</p>
        <button type="button" className="competition__remove" onClick={onRemove} aria-label={`${title} verwijderen`}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <ol ref={listRef} className="competition__bars">
        {standings.map(({ label, laps }) => {
          const behind = leaderLaps - laps;
          return (
            <li
              key={label.id}
              data-label-id={label.id}
              className={`competition__row${laps > 0 && behind === 0 ? ' is-leading' : ''}`}
              style={{ '--team': label.color, '--share': leaderLaps ? laps / leaderLaps : 0 } as React.CSSProperties}
            >
              <span className="competition__team">
                {label.imageUrl ? (
                  <img src={label.imageUrl} alt="" />
                ) : (
                  <i className="competition__dot" aria-hidden="true" />
                )}
                <span>{label.name}</span>
              </span>
              <span className="competition__track">
                <i className="competition__bar" aria-hidden="true" />
                <strong
                  key={laps}
                  className={`competition__laps${changed.has(`${label.id}:${laps}`) ? ' value-tick' : ''}`}
                >
                  {laps.toLocaleString('nl-BE')}
                  <span className="visually-hidden"> rondes</span>
                </strong>
                {behind > 0 && (
                  <em className="competition__behind">
                    −{behind.toLocaleString('nl-BE')}
                    <span className="visually-hidden"> op de leider</span>
                  </em>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function competitionVerdict(standings: Array<{ label: Label; laps: number }>) {
  const [leader, second] = standings;
  if (leader.laps === 0) return 'Nog geen rondes';
  const tied = standings.filter((standing) => standing.laps === leader.laps);
  if (tied.length === standings.length) return 'Gelijke stand';
  if (tied.length > 1) return `${tied.map((standing) => standing.label.name).join(' en ')} staan gelijk`;
  const lead = leader.laps - second.laps;
  return `${leader.label.name} leidt met ${lead === 1 ? '1 ronde' : `${lead} rondes`}`;
}

function countLapsByLabel(laps: LapRecord[]) {
  const counts = new Map<string, number>();
  for (const lap of laps) {
    for (const label of lap.labels) counts.set(label.id, (counts.get(label.id) ?? 0) + 1);
  }
  return counts;
}
