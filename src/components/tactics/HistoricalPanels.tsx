import React from 'react';
import { teamById, type HistoricalRace } from '../../lib/tactics';
import { HistoricalDeepDive } from './HistoricalDeepDive';
import { APOLLOON_TEAM_ID, VTK_TEAM_ID } from './tacticsFormat';
import { TacticsSectionHeader } from './tacticsCharts';

export function HistoricalAnalysisSection({
  historicalRace,
  historicalSourceName,
  historicalError,
  onHistoricalRaceLoad,
  onHistoricalRaceClear,
}: {
  historicalRace: HistoricalRace | null;
  historicalSourceName: string;
  historicalError: string | null;
  onHistoricalRaceLoad: (jsonText: string, fileName: string) => void;
  onHistoricalRaceClear: () => void;
}) {
  const availableTeamIds = historicalRace?.teams.map((team) => team.teamId) ?? [];
  const [firstTeamId, setFirstTeamId] = React.useState(APOLLOON_TEAM_ID);
  const [secondTeamId, setSecondTeamId] = React.useState(VTK_TEAM_ID);

  if (!historicalRace) {
    return (
      <HistoricalDataNotice
        error={historicalError}
        onHistoricalRaceLoad={onHistoricalRaceLoad}
        expanded
      />
    );
  }

  const firstTeam = teamById(historicalRace, firstTeamId) ?? historicalRace.teams[0] ?? null;
  const secondTeam = teamById(historicalRace, secondTeamId) ?? historicalRace.teams[1] ?? firstTeam;

  return (
    <div className="tactics-section-stack">
      <section className="panel tactics-historical-controls">
        <TacticsSectionHeader
          kicker="Historische editie"
          title="Analyse van vorig jaar"
          text="Bekijk eerst de volledige editie op zichzelf. Dezezelfde gegevens worden daarna automatisch als referentie gebruikt in de live sectie."
        />
        <div className="tactics-control-grid tactics-control-grid--historical">
          <label>
            <span>Eerste team</span>
            <select className="input" value={firstTeam?.teamId ?? ''} onChange={(event) => setFirstTeamId(Number(event.target.value))}>
              {availableTeamIds.map((teamId) => <option key={teamId} value={teamId}>Team {teamId}</option>)}
            </select>
          </label>
          <label>
            <span>Tweede team</span>
            <select className="input" value={secondTeam?.teamId ?? ''} onChange={(event) => setSecondTeamId(Number(event.target.value))}>
              {availableTeamIds.map((teamId) => <option key={teamId} value={teamId}>Team {teamId}</option>)}
            </select>
          </label>
          <div className="tactics-dataset-summary">
            <span>Bronbestand</span>
            <strong>{historicalSourceName}</strong>
            <small>{historicalRace.teams.length} teams beschikbaar</small>
          </div>
        </div>
      </section>

      {firstTeam && secondTeam && (
        <HistoricalDeepDive
          historicalRace={historicalRace}
          firstTeam={firstTeam}
          secondTeam={secondTeam}
        />
      )}

      <HistoricalDatasetManager
        sourceName={historicalSourceName}
        teamCount={historicalRace.teams.length}
        error={historicalError}
        onHistoricalRaceLoad={onHistoricalRaceLoad}
        onHistoricalRaceClear={onHistoricalRaceClear}
      />
    </div>
  );
}

export function HistoricalDataNotice({
  error,
  onHistoricalRaceLoad,
  expanded = false,
}: {
  error: string | null;
  onHistoricalRaceLoad: (jsonText: string, fileName: string) => void;
  expanded?: boolean;
}) {
  return (
    <section className={`panel tactics-reference-notice${expanded ? ' tactics-reference-notice--expanded' : ''}`}>
      <div>
        <span className="page-kicker">Eenmalige instelling</span>
        <h2>Laad de officiële resultaten van vorig jaar</h2>
        <p>
          De huidige race komt automatisch uit Apolloon. Alleen de historische organisatordata moet één keer gekozen worden en blijft daarna op deze laptop bewaard.
        </p>
        {error && <div className="warning-banner" role="alert">{error}</div>}
      </div>
      <HistoricalFilePicker onHistoricalRaceLoad={onHistoricalRaceLoad} />
    </section>
  );
}

export function HistoricalDatasetManager({
  sourceName,
  teamCount,
  error,
  onHistoricalRaceLoad,
  onHistoricalRaceClear,
}: {
  sourceName: string;
  teamCount: number;
  error: string | null;
  onHistoricalRaceLoad: (jsonText: string, fileName: string) => void;
  onHistoricalRaceClear: () => void;
}) {
  return (
    <section className="panel tactics-dataset-manager">
      <div>
        <span className="page-kicker">Referentiedata</span>
        <h2>{sourceName}</h2>
        <p>{teamCount} teams ingelezen en lokaal bewaard op deze laptop.</p>
        {error && <div className="warning-banner" role="alert">{error}</div>}
      </div>
      <div className="tactics-dataset-actions">
        <HistoricalFilePicker onHistoricalRaceLoad={onHistoricalRaceLoad} compact />
        <button className="btn btn--ghost" onClick={onHistoricalRaceClear}>Quivr 2025 herstellen</button>
      </div>
    </section>
  );
}

function HistoricalFilePicker({
  onHistoricalRaceLoad,
  compact = false,
}: {
  onHistoricalRaceLoad: (jsonText: string, fileName: string) => void;
  compact?: boolean;
}) {
  return (
    <label className="file-picker tactics-file-picker">
      <input
        type="file"
        accept=".json,.txt,application/json,text/plain"
        onChange={(event) => {
          const selectedFile = event.target.files?.[0];
          if (!selectedFile) return;
          void selectedFile.text().then((jsonText) => onHistoricalRaceLoad(jsonText, selectedFile.name));
          event.target.value = '';
        }}
      />
      <span>{compact ? 'Ander bestand kiezen' : 'Resultaten vorig jaar kiezen'}</span>
    </label>
  );
}
