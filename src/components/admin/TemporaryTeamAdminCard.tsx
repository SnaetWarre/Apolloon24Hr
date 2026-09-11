import React from 'react';
import { LabelBadge } from '../LabelBadge';
import { formatClockTimeMs } from '../../lib/time';
import { compareRunnerIdentity } from './adminFormat';
import { RunnerIdentity } from './RunnerIdentity';
import type { Label, Runner, TemporaryTeam } from '../../types';

export function TemporaryTeamAdminCard({
  label,
  team,
  allTeams,
  runners,
  onSaveMembers,
  onSetActive,
}: {
  label: Label;
  team: TemporaryTeam;
  allTeams: TemporaryTeam[];
  runners: Runner[];
  onSaveMembers: (labelId: string, runnerIds: string[]) => Promise<TemporaryTeam>;
  onSetActive: (labelId: string, active: boolean) => Promise<TemporaryTeam>;
}) {
  const [selectedIds, setSelectedIds] = React.useState<string[]>(team.memberRunnerIds);
  const [query, setQuery] = React.useState('');
  const [membersOpen, setMembersOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelectedIds(team.memberRunnerIds);
  }, [team.memberRunnerIds.join('|')]);

  const otherMemberIds = new Set(
    allTeams.filter((item) => item.labelId !== team.labelId).flatMap((item) => item.memberRunnerIds)
  );
  const selectedRunners = selectedIds
    .map((id) => runners.find((runner) => runner.id === id))
    .filter((runner): runner is Runner => Boolean(runner))
    .sort(compareRunnerIdentity);
  const normalizedQuery = query.trim().toLowerCase();
  const availableRunners = runners
    .filter((runner) => !selectedIds.includes(runner.id))
    .filter((runner) => {
      if (!normalizedQuery) return true;
      return (
        runner.name.toLowerCase().includes(normalizedQuery) ||
        (runner.runnerNumber || '').toLowerCase().includes(normalizedQuery) ||
        runner.labels.some((item) => item.name.toLowerCase().includes(normalizedQuery))
      );
    })
    .sort(compareRunnerIdentity);
  const dirty = [...selectedIds].sort().join('|') !== [...team.memberRunnerIds].sort().join('|');

  function openMembers() {
    setSelectedIds(team.memberRunnerIds);
    setQuery('');
    setFeedback(null);
    setMembersOpen(true);
  }

  function closeMembers() {
    if (dirty && !window.confirm('Niet-opgeslagen wijzigingen aan de ledenlijst weggooien?')) return;
    setMembersOpen(false);
  }

  async function saveMembers() {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onSaveMembers(team.labelId, selectedIds);
      setFeedback(`${selectedIds.length} leden opgeslagen.`);
      setMembersOpen(false);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Ledenlijst opslaan mislukt');
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    if (!membersOpen) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMembers();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [membersOpen, dirty]);

  async function changeActive() {
    if (busy) return;
    const action = team.active ? 'deactiveren' : 'activeren';
    if (!window.confirm(`${label.name} ${action} voor ${team.memberRunnerIds.length} lopers?`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onSetActive(team.labelId, !team.active);
      setFeedback(team.active ? 'Gewone speedteams zijn hersteld.' : `${label.name} is actief.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : `${label.name} ${action} mislukt`);
    } finally {
      setBusy(false);
    }
  }

  const memberNames = team.memberRunnerIds
    .map((id) => runners.find((runner) => runner.id === id))
    .filter((runner): runner is Runner => Boolean(runner));

  return (
    <>
      <article className={`temporary-team-card${team.active ? ' is-active' : ''}`}>
      <div className="panel-heading-row">
        <div>
          <LabelBadge label={label} />
          <p className="panel-copy">
            {team.active
              ? `Actief sinds ${team.activatedAt ? formatClockTimeMs(team.activatedAt) : 'onbekend'}`
              : `${team.memberRunnerIds.length} leden ingesteld`}
          </p>
        </div>
        <span className={`status-badge${team.active ? ' status-badge--running' : ''}`}>
          {team.active ? 'Actief' : 'Niet actief'}
        </span>
      </div>

      <div className="temporary-team-summary">
        <span className="muted-label">Huidige leden</span>
        {memberNames.length ? (
          <div className="temporary-team-member-preview">
            {memberNames.slice(0, 5).map((runner) => (
              <span key={runner.id}>{runner.runnerNumber ? `${runner.runnerNumber} · ` : ''}{runner.name}</span>
            ))}
            {memberNames.length > 5 && <em>+{memberNames.length - 5} andere</em>}
          </div>
        ) : (
          <div className="empty-inline">Nog geen leden geselecteerd.</div>
        )}
      </div>
      <div className="form-row form-row--plain">
        <button className="btn btn--ghost" onClick={openMembers} disabled={busy}>
          {team.active ? 'Ledenlijst bekijken' : 'Ledenlijst beheren'}
        </button>
        <button
          className={`btn ${team.active ? 'btn--danger' : 'btn--primary'}`}
          onClick={changeActive}
          disabled={busy || (!team.active && team.memberRunnerIds.length === 0)}
        >
          {busy ? 'Bezig...' : team.active ? 'Deactiveren' : 'Activeren'}
        </button>
      </div>
      {feedback && <div className="host-hint">{feedback}</div>}
      </article>

      {membersOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Ledenlijst ${label.name}`}>
          <div className="modal temporary-team-modal">
            <div className="modal-header">
              <div>
                <span className="muted-label">Tijdelijke nachtploeg</span>
                <h2>Ledenlijst beheren</h2>
                <p><LabelBadge label={label} /> · {selectedIds.length} geselecteerd</p>
              </div>
              <button className="icon-btn" onClick={closeMembers} aria-label="Sluiten">x</button>
            </div>

            {team.active && (
              <div className="warning-banner">De ploeg is actief. Deactiveer ze eerst om de ledenlijst te wijzigen.</div>
            )}

            <div className="temporary-team-member-manager">
              <section className="temporary-team-member-column temporary-team-member-column--selected">
                <div className="temporary-team-column-heading">
                  <div>
                    <span className="muted-label">Geselecteerd</span>
                    <h3>Huidige leden</h3>
                  </div>
                  <strong>{selectedRunners.length}</strong>
                </div>
                <div className="temporary-team-member-list">
                  {selectedRunners.length ? selectedRunners.map((runner) => (
                    <div key={runner.id} className="temporary-team-member-row">
                      <RunnerIdentity runner={runner} />
                      {!team.active && (
                        <button
                          className="btn btn--danger btn--sm"
                          onClick={() => setSelectedIds((current) => current.filter((id) => id !== runner.id))}
                        >
                          Verwijder
                        </button>
                      )}
                    </div>
                  )) : <div className="empty-inline">Nog niemand geselecteerd.</div>}
                </div>
              </section>

              <section className="temporary-team-member-column">
                <div className="temporary-team-column-heading">
                  <div>
                    <span className="muted-label">Beschikbaar</span>
                    <h3>Lopers toevoegen</h3>
                  </div>
                  <strong>{availableRunners.length}</strong>
                </div>
                <input
                  autoFocus
                  className="input input--search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Zoek op nummer, naam of speedteam..."
                />
                <div className="temporary-team-member-list">
                  {availableRunners.length ? availableRunners.map((runner) => {
                    const assignedElsewhere = otherMemberIds.has(runner.id);
                    const baseTeams = runner.labels.filter((item) => item.kind === 'speedteam');
                    const invalidBaseTeam = baseTeams.length !== 1;
                    return (
                      <div key={runner.id} className={`temporary-team-member-row${assignedElsewhere || invalidBaseTeam ? ' is-disabled' : ''}`}>
                        <RunnerIdentity
                          runner={runner}
                          detail={assignedElsewhere
                            ? 'Zit al in een andere nachtploeg'
                            : invalidBaseTeam
                              ? 'Heeft niet exact één speedteam'
                              : baseTeams[0].name}
                        />
                        <button
                          className="btn btn--primary btn--sm"
                          disabled={team.active || assignedElsewhere || invalidBaseTeam}
                          onClick={() =>
                            setSelectedIds((current) =>
                              current.includes(runner.id) ? current : [...current, runner.id]
                            )
                          }
                        >
                          Voeg toe
                        </button>
                      </div>
                    );
                  }) : <div className="empty-inline">Geen lopers gevonden.</div>}
                </div>
              </section>
            </div>

            <div className="temporary-team-modal-actions">
              <button className="btn btn--ghost" onClick={closeMembers}>Annuleren</button>
              {!team.active && (
                <button className="btn btn--primary" onClick={saveMembers} disabled={busy || !dirty}>
                  {busy ? 'Opslaan...' : `Ledenlijst opslaan (${selectedIds.length})`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
