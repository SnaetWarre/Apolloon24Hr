import React from 'react';
import { LabelBadge } from '../LabelBadge';
import { useConfirm } from '../ConfirmDialog';
import { ModalDialog } from '../ModalDialog';
import { runnerMatchesSearch } from '../../lib/runners';
import { formatClockTimeMs } from '../../lib/time';
import { compareRunnerIdentity, currentTeamName } from './adminFormat';
import { RunnerIdentity } from './RunnerIdentity';
import { formatTeamWindow, parseTeamWindow, toLocalDateTime } from './temporaryTeamTime';
import type { Label, Runner, TemporaryTeam } from '../../types';

export function TemporaryTeamAdminCard({
  label,
  team,
  allTeams,
  runners,
  onSaveMembers,
  onSetActive,
  onSetSchedule,
}: {
  label: Label;
  team: TemporaryTeam;
  allTeams: TemporaryTeam[];
  runners: Runner[];
  onSaveMembers: (labelId: string, runnerIds: string[]) => Promise<TemporaryTeam>;
  onSetActive: (labelId: string, active: boolean) => Promise<TemporaryTeam>;
  onSetSchedule: (labelId: string, startsAt: number, endsAt: number) => Promise<TemporaryTeam>;
}) {
  const confirm = useConfirm();
  const [selectedIds, setSelectedIds] = React.useState<string[]>(team.memberRunnerIds);
  const [query, setQuery] = React.useState('');
  const [membersOpen, setMembersOpen] = React.useState(false);
  const memberSearchRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = React.useState(false);
  const [start, setStart] = React.useState(team.startsAt === null ? '' : toLocalDateTime(team.startsAt));
  const [end, setEnd] = React.useState(team.endsAt === null ? '' : toLocalDateTime(team.endsAt));

  React.useEffect(() => {
    if (editingSchedule) return;
    setStart(team.startsAt === null ? '' : toLocalDateTime(team.startsAt));
    setEnd(team.endsAt === null ? '' : toLocalDateTime(team.endsAt));
  }, [team.startsAt, team.endsAt, editingSchedule]);

  const memberKey = team.memberRunnerIds.join('|');
  React.useEffect(() => {
    setSelectedIds(memberKey ? memberKey.split('|') : []);
  }, [memberKey]);

  const otherMemberIds = new Set(
    allTeams.filter((item) => item.labelId !== team.labelId).flatMap((item) => item.memberRunnerIds)
  );
  const selectedRunners = selectedIds
    .map((id) => runners.find((runner) => runner.id === id))
    .filter((runner): runner is Runner => Boolean(runner))
    .sort(compareRunnerIdentity);
  const availableRunners = runners
    .filter((runner) => !selectedIds.includes(runner.id))
    .filter((runner) => runnerMatchesSearch(runner, query))
    .sort(compareRunnerIdentity);
  const dirty = [...selectedIds].sort().join('|') !== [...team.memberRunnerIds].sort().join('|');

  function openMembers() {
    setSelectedIds(team.memberRunnerIds);
    setQuery('');
    setFeedback(null);
    setMembersOpen(true);
  }

  async function closeMembers() {
    if (
      dirty &&
      !(await confirm({
        title: 'Wijzigingen weggooien?',
        message: 'De aanpassingen aan de ledenlijst zijn nog niet opgeslagen.',
        confirmLabel: 'Weggooien',
        cancelLabel: 'Verder bewerken',
        tone: 'danger',
      }))
    )
      return;
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

  async function changeActive() {
    if (busy) return;
    const action = team.active ? 'deactiveren' : 'activeren';
    if (
      !(await confirm({
        title: `${label.name} ${action}?`,
        message: `Dit geldt voor ${team.memberRunnerIds.length} lopers.`,
        confirmLabel: team.active ? 'Deactiveren' : 'Activeren',
      }))
    )
      return;
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

  async function saveSchedule(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFeedback(null);
    try {
      const window = parseTeamWindow(start, end);
      setBusy(true);
      const updated = await onSetSchedule(team.labelId, window.startsAt, window.endsAt);
      setFeedback(
        updated.active
          ? 'Planning opgeslagen. De ploeg is nu actief.'
          : 'Planning opgeslagen. De ploeg schakelt automatisch om.'
      );
      setEditingSchedule(false);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Planning opslaan mislukt.');
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
                <span key={runner.id}>
                  {runner.runnerNumber ? `${runner.runnerNumber} · ` : ''}
                  {runner.name}
                </span>
              ))}
              {memberNames.length > 5 && <em>+{memberNames.length - 5} andere</em>}
            </div>
          ) : (
            <div className="empty-inline">Nog geen leden geselecteerd.</div>
          )}
        </div>
        {team.startsAt !== null && team.endsAt !== null && (
          <p className="temporary-team-schedule-summary">
            <strong>Planning:</strong> {formatTeamWindow(team.startsAt)} tot {formatTeamWindow(team.endsAt)}
            {team.active ? ' · Nu actief' : Date.now() >= team.endsAt ? ' · Afgelopen' : ' · Nog niet gestart'}
          </p>
        )}
        {editingSchedule && (
          <form className="temporary-team-schedule-edit" onSubmit={saveSchedule}>
            <label className="stacked-label">
              Begin
              <input
                autoFocus
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
            <button className="btn btn--primary btn--sm" disabled={busy}>
              Planning opslaan
            </button>
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              onClick={() => setEditingSchedule(false)}
              disabled={busy}
            >
              Annuleren
            </button>
          </form>
        )}
        <div className="form-row form-row--plain">
          <button className="btn btn--ghost" onClick={openMembers} disabled={busy}>
            Ledenlijst beheren
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => setEditingSchedule(true)}
            disabled={busy || editingSchedule}
          >
            Planning aanpassen
          </button>
          {team.startsAt === null && (
            <button
              className={`btn ${team.active ? 'btn--danger' : 'btn--primary'}`}
              onClick={changeActive}
              disabled={busy || (!team.active && team.memberRunnerIds.length === 0)}
            >
              {busy ? 'Bezig...' : team.active ? 'Deactiveren' : 'Activeren'}
            </button>
          )}
        </div>
        {feedback && <div className="host-hint">{feedback}</div>}
      </article>

      {membersOpen && (
        <ModalDialog
          label={`Ledenlijst ${label.name}`}
          onRequestClose={() => void closeMembers()}
          initialFocusRef={memberSearchRef}
        >
          <div className="modal temporary-team-modal">
            <div className="modal-header">
              <div>
                <span className="muted-label">Tijdelijke nachtploeg</span>
                <h2>Ledenlijst beheren</h2>
                <p>
                  <LabelBadge label={label} /> · {selectedIds.length} geselecteerd
                </p>
              </div>
              <button className="icon-btn" onClick={() => void closeMembers()} aria-label="Sluiten">
                x
              </button>
            </div>

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
                  {selectedRunners.length ? (
                    selectedRunners.map((runner) => (
                      <div key={runner.id} className="temporary-team-member-row">
                        <RunnerIdentity runner={runner} />
                        <button
                          className="btn btn--danger btn--sm"
                          onClick={() => setSelectedIds((current) => current.filter((id) => id !== runner.id))}
                        >
                          Verwijder
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="empty-inline">Nog niemand geselecteerd.</div>
                  )}
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
                  ref={memberSearchRef}
                  className="input input--search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Zoek op nummer, naam of speedteam..."
                />
                <div className="temporary-team-member-list">
                  {availableRunners.length ? (
                    availableRunners.map((runner) => {
                      const assignedElsewhere = otherMemberIds.has(runner.id);
                      return (
                        <div
                          key={runner.id}
                          className={`temporary-team-member-row${assignedElsewhere ? ' is-disabled' : ''}`}
                        >
                          <RunnerIdentity
                            runner={runner}
                            detail={assignedElsewhere ? 'Zit al in een andere nachtploeg' : currentTeamName(runner)}
                          />
                          <button
                            className="btn btn--primary btn--sm"
                            disabled={assignedElsewhere}
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
                    })
                  ) : (
                    <div className="empty-inline">Geen lopers gevonden.</div>
                  )}
                </div>
              </section>
            </div>

            <div className="temporary-team-modal-actions">
              <button className="btn btn--ghost" onClick={() => void closeMembers()}>
                Annuleren
              </button>
              <button className="btn btn--primary" onClick={saveMembers} disabled={busy || !dirty}>
                {busy ? 'Opslaan...' : `Ledenlijst opslaan (${selectedIds.length})`}
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </>
  );
}
