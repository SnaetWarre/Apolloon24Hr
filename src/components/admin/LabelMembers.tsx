import React from 'react';
import { useAppActions, useRegistrations } from '../../app/index';
import { labelMembers, runnersToAdd, suggestedMembers } from '../../lib/labels';
import { runnerLabel } from '../../lib/runners';
import type { Label, Runner } from '../../types';
import { useAdminAction } from './useAdminAction';

/** Who is in a label, with a search box to add runners and an × to take them out. */
export function LabelMembers({ label, runners }: { label: Label; runners: Runner[] }) {
  const registrations = useRegistrations();
  const { addRunnerToLabel, removeRunnerFromLabel } = useAppActions();
  const { pending, run } = useAdminAction();
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);
  const members = labelMembers(runners, label.id);
  const matches = runnersToAdd(runners, label.id, query);
  const suggestions = suggestedMembers(runners, label, registrations);
  const otherSpeedteam = (runner: Runner) =>
    label.kind === 'speedteam'
      ? runner.labels.find((own) => own.kind === 'speedteam' && own.id !== label.id)
      : undefined;

  async function add(runner: Runner) {
    const added = await run(
      () => addRunnerToLabel({ labelId: label.id, runnerId: runner.id }),
      `${runner.name} zit nu in ${label.name}.`,
      'Toevoegen mislukt'
    );
    if (!added) return;
    setQuery('');
    // The clicked match disappears; typing the next name goes on in the box.
    searchRef.current?.focus();
  }

  function remove(runner: Runner) {
    void run(
      () => removeRunnerFromLabel({ labelId: label.id, runnerId: runner.id }),
      `${runner.name} is uit ${label.name} gehaald.`,
      'Verwijderen mislukt'
    );
  }

  return (
    <div className="label-members">
      <div className="label-members__add">
        <input
          ref={searchRef}
          className="input"
          type="search"
          aria-label={`Loper toevoegen aan ${label.name}`}
          placeholder="Naam of nummer, Enter om toe te voegen"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || pending || !matches[0]) return;
            event.preventDefault();
            void add(matches[0]);
          }}
        />
        {query.trim() && (
          <ul className="label-members__matches" aria-label="Gevonden lopers">
            {matches.map((runner) => {
              const other = otherSpeedteam(runner);
              return (
                <li key={runner.id}>
                  <button className="btn btn--sm btn--quiet" disabled={pending} onClick={() => void add(runner)}>
                    + {runnerLabel(runner)}
                    {other && <span className="label-members__hint">nu in {other.name}</span>}
                  </button>
                </li>
              );
            })}
            {!matches.length && <li className="label-members__hint">Geen loper gevonden buiten {label.name}</li>}
          </ul>
        )}
      </div>

      {members.length ? (
        <ul className="label-members__list" aria-label={`Lopers in ${label.name}`}>
          {members.map((runner) => (
            <li key={runner.id} className="label-member">
              <span className="label-member__name">{runnerLabel(runner)}</span>
              <button
                className="icon-btn label-member__remove"
                aria-label={`${runner.name} uit ${label.name} halen`}
                title="Uit dit label halen"
                disabled={pending}
                onClick={() => remove(runner)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="label-members__hint">Nog niemand in {label.name}.</p>
      )}

      {suggestions.length > 0 && (
        <details className="label-members__suggestions">
          <summary>
            Misschien ook: {suggestions.length} {suggestions.length === 1 ? 'loper' : 'lopers'}
          </summary>
          <p className="label-members__hint">
            Hun studiefase past bij {label.name}, maar ze vinkten het vakje in het formulier niet aan.
          </p>
          <ul>
            {suggestions.map((runner) => (
              <li key={runner.id}>
                <span className="label-member__name">{runnerLabel(runner)}</span>
                <span className="label-members__hint">"{registrations[runner.id]?.studyPhase}"</span>
                <button className="btn btn--sm" disabled={pending} onClick={() => void add(runner)}>
                  Toevoegen
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
