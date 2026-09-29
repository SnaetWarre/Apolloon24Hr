import React from 'react';
import type { Runner, TemporaryTeam } from '../../types';
import { compareRunnerIdentity, currentTeamName } from './adminFormat';
import { formatTeamWindow, parseTeamWindow, toLocalDateTime } from './temporaryTeamTime';

export function TemporaryTeamCreateForm({
  runners,
  allTeams,
  onCreate,
}: {
  runners: Runner[];
  allTeams: TemporaryTeam[];
  onCreate: (input: {
    name: string;
    color: string;
    startsAt: number;
    endsAt: number;
    runnerIds: string[];
  }) => Promise<TemporaryTeam>;
}) {
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState('#7c3aed');
  const [start, setStart] = React.useState(() => toLocalDateTime(Date.now()));
  const [end, setEnd] = React.useState(() => toLocalDateTime(Date.now() + 60 * 60_000));
  const [query, setQuery] = React.useState('');
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const assignedIds = new Set(allTeams.flatMap((team) => team.memberRunnerIds));
  const visibleRunners = runners
    .filter((runner) =>
      `${runner.runnerNumber ?? ''} ${runner.name} ${runner.labels.map((label) => label.name).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase().trim())
    )
    .sort(compareRunnerIdentity);
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    try {
      const window = parseTeamWindow(start, end);
      if (!selectedIds.length) throw new Error('Selecteer minstens één loper.');
      setBusy(true);
      const team = await onCreate({ name: name.trim(), color, ...window, runnerIds: selectedIds });
      setMessage(
        team.active
          ? `${name.trim()} is aangemaakt en meteen actief.`
          : Date.now() >= window.endsAt
            ? `${name.trim()} is aangemaakt. De ingestelde periode is al voorbij.`
            : `${name.trim()} is aangemaakt. De ploeg start automatisch.`
      );
      setName('');
      setSelectedIds([]);
      setStart(toLocalDateTime(Date.now()));
      setEnd(toLocalDateTime(Date.now() + 60 * 60_000));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ploeg aanmaken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="temporary-team-create" onSubmit={create}>
      <div className="temporary-team-create__fields">
        <label className="stacked-label">
          Naam
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Bijvoorbeeld Trojan Horse"
            required
          />
        </label>
        <label className="stacked-label">
          Kleur
          <input
            className="input input--color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </label>
        <label className="stacked-label">
          Begin
          <input
            className="input"
            type="datetime-local"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            required
          />
        </label>
        <label className="stacked-label">
          Einde
          <input
            className="input"
            type="datetime-local"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            required
          />
        </label>
      </div>
      <p className="panel-copy">
        Kies bij een nachtploeg de volgende dag als einddatum. Ligt het begin al in het verleden en het einde nog in de
        toekomst, dan wordt de ploeg meteen actief.
      </p>
      {Number.isFinite(startMs) && Number.isFinite(endMs) && (
        <p className="temporary-team-window-preview">
          Gekozen periode: {formatTeamWindow(startMs)} tot {formatTeamWindow(endMs)}
        </p>
      )}
      <label className="stacked-label" htmlFor="temporary-team-runner-search">
        Lopers ({selectedIds.length} geselecteerd)
      </label>
      {selectedIds.length > 0 && (
        <div className="temporary-team-create__selected" aria-label="Geselecteerde lopers">
          {selectedIds.map((id) => {
            const runner = runners.find((item) => item.id === id);
            return runner ? (
              <span key={id}>
                {runner.runnerNumber ? `${runner.runnerNumber} · ` : ''}
                {runner.name}
              </span>
            ) : null;
          })}
        </div>
      )}
      <input
        id="temporary-team-runner-search"
        className="input input--search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Zoek op naam, nummer of speedteam"
      />
      <div className="temporary-team-create__runners" aria-label="Lopers kiezen">
        {visibleRunners.map((runner) => {
          const assigned = assignedIds.has(runner.id);
          return (
            <label key={runner.id} className={`temporary-team-create__runner${assigned ? ' is-disabled' : ''}`}>
              <input
                type="checkbox"
                checked={selectedIds.includes(runner.id)}
                disabled={assigned || busy}
                onChange={(event) =>
                  setSelectedIds((current) =>
                    event.target.checked ? [...current, runner.id] : current.filter((id) => id !== runner.id)
                  )
                }
              />
              <span>
                <strong>
                  {runner.runnerNumber ? `${runner.runnerNumber} · ` : ''}
                  {runner.name}
                </strong>
                <small>{assigned ? 'Zit al in een nachtploeg' : currentTeamName(runner)}</small>
              </span>
            </label>
          );
        })}
        {!visibleRunners.length && <div className="empty-inline">Geen lopers gevonden.</div>}
      </div>
      <div className="form-row form-row--plain">
        <button className="btn btn--primary" type="submit" disabled={busy || !name.trim() || !selectedIds.length}>
          {busy ? 'Aanmaken...' : 'Ploeg aanmaken en plannen'}
        </button>
      </div>
      {message && (
        <div className="host-hint" role="status">
          {message}
        </div>
      )}
    </form>
  );
}
