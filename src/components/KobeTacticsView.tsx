import React from 'react';
import {
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import { useAppData, useRaceHistory } from '../app/index';
import {
  DEFAULT_MAXIMUM_LAP_SECONDS,
  DEFAULT_MINIMUM_LAP_SECONDS,
  RACE_DURATION_HOURS,
  buildHourlyPaceComparison,
  buildRaceProgress,
  buildTargetPaces,
  formatSignedLapDifference,
  historicalLapCountAt,
  parseHistoricalRace,
  projectedLapCount,
  recentMedianPaceSeconds,
  targetLapCountAt,
  teamById,
  validLiveLaps,
  type HistoricalRace,
  type HourlyPacePoint,
  type RaceProgressPoint,
} from '../lib/tactics';
import {
  buildLiveQuarterHourTrend,
  buildLiveRivalTimeGap,
  projectScenarioRange,
  type LiveTrendPoint,
  type TimeGapPoint,
} from '../lib/tacticsDeepDive';
import { formatClockTimeMs, formatDurationMs, nowMs } from '../lib/time';
import { useClockTick } from '../lib/useAnimationFrameTick';
import type { LapRecord, LiveAppSnapshot } from '../types';
import { HistoricalDeepDive } from './tactics/HistoricalDeepDive';

Chart.register(
  CategoryScale,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip
);

const HISTORICAL_RACE_STORAGE_KEY = 'apolloon.kobe-tactics.historical-race.v1';
const HISTORICAL_RACE_NAME_STORAGE_KEY = 'apolloon.kobe-tactics.historical-race-name.v1';
const TACTICS_SCENARIO_STORAGE_KEY = 'apolloon.kobe-tactics.scenario.v1';
const BUNDLED_REFERENCE_URL = '/reference/quivr-2025-lap-times.json';
const BUNDLED_REFERENCE_NAME = 'Quivr 2025';
const MAX_CHART_PIXEL_RATIO = 1.5;
const APOLLOON_TEAM_ID = 1;
const VTK_TEAM_ID = 4;
const DEFAULT_TARGET_LAPS = 800;

type TacticsSection = 'live' | 'historical';
type TargetProfile = 'flat' | 'apolloon' | 'vtk';
type StoredTacticsScenario = {
  targetLaps: number;
  targetProfile: TargetProfile;
  targetPaces: number[];
};

const selectTacticsData = ({ race }: LiveAppSnapshot) => ({ race });

export function KobeTacticsView() {
  const { race } = useAppData(selectTacticsData);
  useClockTick(30_000, race.raceStartedAt != null && race.raceFinishedAt == null);
  const {
    laps,
    loading: historyLoading,
    error: historyError,
  } = useRaceHistory({ scope: 'full' });
  const [section, setSection] = React.useState<TacticsSection>('live');
  const storedHistoricalRace = React.useMemo(loadStoredHistoricalRace, []);
  const [historicalRace, setHistoricalRace] = React.useState<HistoricalRace | null>(storedHistoricalRace);
  const [historicalSourceName, setHistoricalSourceName] = React.useState(
    () => localStorage.getItem(HISTORICAL_RACE_NAME_STORAGE_KEY) || BUNDLED_REFERENCE_NAME
  );
  const [historicalError, setHistoricalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (historicalRace) return;
    let cancelled = false;
    void fetch(BUNDLED_REFERENCE_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Quivr-referentie laden mislukt (${response.status}).`);
        return response.text();
      })
      .then((jsonText) => {
        if (cancelled) return;
        setHistoricalRace(parseHistoricalRace(jsonText));
        setHistoricalSourceName(BUNDLED_REFERENCE_NAME);
        setHistoricalError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setHistoricalError(error instanceof Error ? error.message : 'De Quivr-referentie kon niet worden geladen.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [historicalRace]);

  function storeHistoricalRace(jsonText: string, fileName: string) {
    try {
      const parsedRace = parseHistoricalRace(jsonText);
      localStorage.setItem(HISTORICAL_RACE_STORAGE_KEY, jsonText);
      localStorage.setItem(HISTORICAL_RACE_NAME_STORAGE_KEY, fileName);
      setHistoricalRace(parsedRace);
      setHistoricalSourceName(fileName);
      setHistoricalError(null);
    } catch (error) {
      setHistoricalError(error instanceof Error ? error.message : 'Het bestand kon niet worden gelezen.');
    }
  }

  function clearHistoricalRace() {
    localStorage.removeItem(HISTORICAL_RACE_STORAGE_KEY);
    localStorage.removeItem(HISTORICAL_RACE_NAME_STORAGE_KEY);
    setHistoricalRace(null);
    setHistoricalSourceName(BUNDLED_REFERENCE_NAME);
    setHistoricalError(null);
  }

  return (
    <>
      <div className="hero hero--compact tactics-hero">
        <div>
          <span className="page-kicker">Wedstrijdstrategie</span>
          <h1 className="app-title">Kobe&apos;s tactiek</h1>
          <p className="tagline">
            Vergelijk vorige edities en stuur het doelverloop bij met de live data uit Apolloon.
          </p>
        </div>
        <div className="tactics-live-badge" role="status">
          <i />
          {historyLoading ? 'Live data laden' : `${laps.length} rondes live gekoppeld`}
        </div>
      </div>

      {historyError && (
        <div className="warning-banner" role="alert">
          De live racegegevens konden niet worden geladen: {historyError.message}
        </div>
      )}

      <div className="tactics-section-switch" aria-label="Tactiekonderdeel">
        <button
          className={section === 'live' ? 'is-active' : ''}
          aria-pressed={section === 'live'}
          onClick={() => setSection('live')}
        >
          <span>Live race &amp; doelverloop</span>
          <small>Automatisch gekoppeld aan het telsysteem</small>
        </button>
        <button
          className={section === 'historical' ? 'is-active' : ''}
          aria-pressed={section === 'historical'}
          onClick={() => setSection('historical')}
        >
          <span>Analyse vorig jaar</span>
          <small>Vergelijk Apolloon met VTK en andere teams</small>
        </button>
      </div>

      {section === 'live' ? (
        <LiveTacticsSection
          laps={laps}
          raceStartedAt={race.raceStartedAt}
          currentTimestamp={race.raceFinishedAt ?? nowMs()}
          historicalRace={historicalRace}
          historicalSourceName={historicalSourceName}
          historicalError={historicalError}
          onHistoricalRaceLoad={storeHistoricalRace}
          onHistoricalRaceClear={clearHistoricalRace}
        />
      ) : (
        <HistoricalAnalysisSection
          historicalRace={historicalRace}
          historicalSourceName={historicalSourceName}
          historicalError={historicalError}
          onHistoricalRaceLoad={storeHistoricalRace}
          onHistoricalRaceClear={clearHistoricalRace}
        />
      )}
    </>
  );
}

function LiveTacticsSection({
  laps,
  raceStartedAt,
  currentTimestamp,
  historicalRace,
  historicalSourceName,
  historicalError,
  onHistoricalRaceLoad,
  onHistoricalRaceClear,
}: {
  laps: LapRecord[];
  raceStartedAt: number | null;
  currentTimestamp: number;
  historicalRace: HistoricalRace | null;
  historicalSourceName: string;
  historicalError: string | null;
  onHistoricalRaceLoad: (jsonText: string, fileName: string) => void;
  onHistoricalRaceClear: () => void;
}) {
  const ownHistoricalTeam = teamById(historicalRace, APOLLOON_TEAM_ID);
  const rivalHistoricalTeam = teamById(historicalRace, VTK_TEAM_ID);
  const [minimumLapSeconds, setMinimumLapSeconds] = React.useState(DEFAULT_MINIMUM_LAP_SECONDS);
  const [maximumLapSeconds, setMaximumLapSeconds] = React.useState(DEFAULT_MAXIMUM_LAP_SECONDS);
  const [recentLapCount, setRecentLapCount] = React.useState(20);
  const storedScenario = React.useMemo(loadStoredTacticsScenario, []);
  const [targetLaps, setTargetLaps] = React.useState(
    () => storedScenario?.targetLaps ?? ownHistoricalTeam?.cumulativeLapTimesMs.length ?? DEFAULT_TARGET_LAPS
  );
  const [targetProfile, setTargetProfile] = React.useState<TargetProfile>(
    storedScenario?.targetProfile ?? (ownHistoricalTeam ? 'apolloon' : 'flat')
  );
  const scenarioWasEdited = React.useRef(Boolean(storedScenario));
  const referenceTeam = targetProfile === 'apolloon'
    ? ownHistoricalTeam
    : targetProfile === 'vtk'
      ? rivalHistoricalTeam
      : null;
  const generatedTargetPaces = React.useMemo(
    () => buildTargetPaces(targetLaps, referenceTeam),
    [referenceTeam, targetLaps]
  );
  const [targetPaces, setTargetPaces] = React.useState(
    () => storedScenario?.targetPaces.length === RACE_DURATION_HOURS
      ? storedScenario.targetPaces
      : generatedTargetPaces
  );
  const targetPacesWereEdited = React.useRef(Boolean(storedScenario));

  React.useEffect(() => {
    if (!ownHistoricalTeam || scenarioWasEdited.current) return;
    setTargetLaps(ownHistoricalTeam.cumulativeLapTimesMs.length);
    setTargetProfile('apolloon');
  }, [ownHistoricalTeam]);

  React.useEffect(() => {
    if (targetPacesWereEdited.current) return;
    setTargetPaces(generatedTargetPaces);
  }, [generatedTargetPaces]);

  React.useEffect(() => {
    localStorage.setItem(TACTICS_SCENARIO_STORAGE_KEY, JSON.stringify({
      targetLaps,
      targetProfile,
      targetPaces,
    } satisfies StoredTacticsScenario));
  }, [targetLaps, targetPaces, targetProfile]);

  if (raceStartedAt == null) {
    return (
      <section className="panel tactics-empty-state">
        <span className="page-kicker">Live race</span>
        <h2>Start eerst de wedstrijd</h2>
        <p>Zodra de race gestart is, verschijnen de live vergelijking en het doelverloop hier automatisch.</p>
      </section>
    );
  }

  const elapsedHours = Math.max(
    0,
    Math.min(RACE_DURATION_HOURS, (currentTimestamp - raceStartedAt) / 3_600_000)
  );
  const cleanLaps = validLiveLaps(laps, raceStartedAt, minimumLapSeconds, maximumLapSeconds);
  const suspiciousLapCount = laps.length - cleanLaps.length;
  const expectedLapsNow = targetLapCountAt(targetPaces, elapsedHours);
  const currentPaceSeconds = recentMedianPaceSeconds(cleanLaps, recentLapCount);
  const recentPaceSpreadSeconds = standardDeviation(
    cleanLaps.slice(-recentLapCount).map((lap) => lap.durationMs / 1_000)
  );
  const scenarioRange = projectScenarioRange(
    cleanLaps.length,
    elapsedHours,
    targetPaces,
    recentPaceSpreadSeconds
  );
  const recentPaceProjection = currentPaceSeconds == null
    ? null
    : projectedLapCount(
      cleanLaps.length,
      elapsedHours,
      Array(RACE_DURATION_HOURS).fill(currentPaceSeconds)
    );
  const ownHistoricalLapsNow = historicalLapCountAt(ownHistoricalTeam, elapsedHours);
  const rivalHistoricalLapsNow = historicalLapCountAt(rivalHistoricalTeam, elapsedHours);
  const progressPoints = buildRaceProgress({
    liveLaps: cleanLaps,
    raceStartedAt,
    elapsedHours,
    targetPacesSeconds: targetPaces,
    ownHistoricalTeam,
    rivalHistoricalTeam,
  });
  const pacePoints = buildHourlyPaceComparison({
    targetPacesSeconds: targetPaces,
    liveLaps: cleanLaps,
    raceStartedAt,
    ownHistoricalTeam,
    rivalHistoricalTeam,
  });
  const trendPoints = buildLiveQuarterHourTrend(
    cleanLaps,
    raceStartedAt,
    elapsedHours,
    ownHistoricalTeam,
    rivalHistoricalTeam
  );
  const rivalTimeGapPoints = buildLiveRivalTimeGap(
    cleanLaps,
    raceStartedAt,
    elapsedHours,
    targetPaces,
    rivalHistoricalTeam
  );

  return (
    <div className="tactics-section-stack">
      {!historicalRace && (
        <HistoricalDataNotice
          error={historicalError}
          onHistoricalRaceLoad={onHistoricalRaceLoad}
        />
      )}

      <section className="stats-grid stats-grid--analysis tactics-live-stats" aria-label="Live tactiek kerncijfers">
        <TacticsStat label="Rondes nu" value={String(cleanLaps.length)} detail={`${formatRaceHour(elapsedHours)} onderweg`} />
        <TacticsStat
          label="Op schema"
          value={formatSignedLapDifference(cleanLaps.length - expectedLapsNow)}
          detail={`${expectedLapsNow.toFixed(1)} verwacht`}
          tone={cleanLaps.length >= expectedLapsNow ? 'positive' : 'negative'}
        />
        <TacticsStat
          label="Projectie na 24u"
          value={Math.round(scenarioRange.expectedLaps).toLocaleString('nl-BE')}
          detail={`${Math.round(scenarioRange.pessimisticLaps)}-${Math.round(scenarioRange.optimisticLaps)} op recente spreiding`}
        />
        <TacticsStat
          label={`Tempo laatste ${recentLapCount}`}
          value={formatPaceSeconds(currentPaceSeconds)}
          detail={recentPaceProjection == null
            ? `${suspiciousLapCount} verdachte ronde${suspiciousLapCount === 1 ? '' : 's'} genegeerd`
            : `${Math.round(recentPaceProjection)} rondes bij dit tempo`}
        />
        <TacticsStat
          label="Vs. Apolloon vorig jaar"
          value={formatSignedLapDifference(ownHistoricalLapsNow == null ? null : cleanLaps.length - ownHistoricalLapsNow)}
          detail={historicalSourceName}
        />
        <TacticsStat
          label="Vs. VTK vorig jaar"
          value={formatSignedLapDifference(rivalHistoricalLapsNow == null ? null : cleanLaps.length - rivalHistoricalLapsNow)}
          detail={historicalSourceName}
        />
      </section>

      <section className="panel tactics-scenario-panel">
        <TacticsSectionHeader
          kicker="Scenario"
          title="Doelverloop simuleren"
          text="Kies een einddoel en gebruik een vlak tempo of het dag-nachtverloop van vorig jaar als vertrekpunt. Pas daarna elk uur afzonderlijk aan."
        />
        <div className="tactics-control-grid">
          <label>
            <span>Doel na 24 uur · gem. {formatPaceSeconds(86_400 / targetLaps)}</span>
            <input
              className="input"
              type="number"
              min={1}
              step={5}
              value={targetLaps}
              onChange={(event) => {
                scenarioWasEdited.current = true;
                targetPacesWereEdited.current = false;
                setTargetLaps(Math.max(1, Number(event.target.value) || 1));
              }}
            />
          </label>
          <label>
            <span>Verloop als basis</span>
            <select
              className="input"
              value={targetProfile}
              onChange={(event) => {
                scenarioWasEdited.current = true;
                targetPacesWereEdited.current = false;
                setTargetProfile(event.target.value as TargetProfile);
              }}
            >
              <option value="flat">Gelijkmatig tempo</option>
              <option value="apolloon" disabled={!ownHistoricalTeam}>Apolloon vorig jaar</option>
              <option value="vtk" disabled={!rivalHistoricalTeam}>VTK vorig jaar</option>
            </select>
          </label>
          <label>
            <span>Recente rondes voor huidig tempo</span>
            <input
              className="input"
              type="number"
              min={5}
              max={100}
              step={5}
              value={recentLapCount}
              onChange={(event) => setRecentLapCount(clamp(Number(event.target.value) || 5, 5, 100))}
            />
          </label>
          <div className="tactics-filter-pair">
            <label>
              <span>Minimum ronde</span>
              <input
                className="input"
                type="number"
                min={10}
                max={maximumLapSeconds}
                value={minimumLapSeconds}
                onChange={(event) => setMinimumLapSeconds(clamp(Number(event.target.value) || 10, 10, maximumLapSeconds))}
              />
            </label>
            <label>
              <span>Maximum ronde</span>
              <input
                className="input"
                type="number"
                min={minimumLapSeconds}
                max={300}
                value={maximumLapSeconds}
                onChange={(event) => setMaximumLapSeconds(clamp(Number(event.target.value) || 300, minimumLapSeconds, 300))}
              />
            </label>
          </div>
        </div>

        <div className="tactics-hourly-header">
          <div>
            <strong>Doeltempo per race-uur</strong>
            <span>Seconden per ronde. Wijzig een uur om het scenario meteen door te rekenen.</span>
          </div>
          <button className="btn btn--ghost" onClick={() => {
            targetPacesWereEdited.current = false;
            setTargetPaces(generatedTargetPaces);
          }}>
            Herbereken uit profiel
          </button>
        </div>
        <div className="tactics-hourly-grid">
          {targetPaces.map((paceSeconds, raceHour) => (
            <label key={raceHour} className={raceHour <= elapsedHours ? 'is-past' : ''}>
              <span>{formatRaceHourWindow(raceStartedAt, raceHour)}</span>
              <div>
                <input
                  type="number"
                  min={30}
                  max={300}
                  step={1}
                  value={Math.round(paceSeconds)}
                  onChange={(event) => {
                    scenarioWasEdited.current = true;
                    targetPacesWereEdited.current = true;
                    const nextPaces = [...targetPaces];
                    nextPaces[raceHour] = clamp(Number(event.target.value) || 30, 30, 300);
                    setTargetPaces(nextPaces);
                  }}
                />
                <em>s</em>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <TacticsSectionHeader
          kicker="Voortgang"
          title="Live tegenover doel en vorig jaar"
          text="Elke nieuwe ronde uit het telsysteem wordt automatisch toegevoegd. De stippellijn toont het gekozen doelverloop tot het einde van de race."
        />
        <RaceProgressChart points={progressPoints} showLive showTarget />
      </section>

      <section className="panel">
        <TacticsSectionHeader
          kicker="Tempo"
          title="Gepland en werkelijk tempo per uur"
          text="Lagere rondetijden zijn sneller. Zo ziet ge meteen in welk uur het plan gewonnen of verloren wordt."
        />
        <HourlyPaceChart points={pacePoints} showPlan showActual />
      </section>

      <section className="panel">
        <TacticsSectionHeader
          kicker="Kwartiertrend"
          title="Live tempo tegenover vorig jaar"
          text="De kwartiermedianen tonen sneller waar het huidige tempo afwijkt van Apolloon en VTK vorig jaar dan de bredere uurblokken."
        />
        <LiveTrendChart points={trendPoints} />
      </section>

      <section className="panel">
        <TacticsSectionHeader
          kicker="Tijdskloof"
          title="Werkelijke en voorspelde achterstand op VTK vorig jaar"
          text="Positief betekent achterstand. Na het huidige racemoment rekent de stippellijn verder met het ingestelde doeltempo per uur."
        />
        {rivalTimeGapPoints.length
          ? <LiveTimeGapChart points={rivalTimeGapPoints} />
          : <p className="empty-inline">Geen VTK-referentie beschikbaar voor deze berekening.</p>}
      </section>

      <section className="panel">
        <div className="tactics-panel-heading">
          <TacticsSectionHeader
            kicker="Controle"
            title="Laatste rondes"
            text="Rechtstreeks uit Apolloon, inclusief rondes die buiten de ingestelde realistische grenzen vallen."
          />
          <span className="tactics-source-pill">Live API</span>
        </div>
        <RecentLapsTable laps={laps} minimumLapSeconds={minimumLapSeconds} maximumLapSeconds={maximumLapSeconds} />
      </section>

      {historicalRace && (
        <HistoricalDatasetManager
          sourceName={historicalSourceName}
          teamCount={historicalRace.teams.length}
          error={historicalError}
          onHistoricalRaceLoad={onHistoricalRaceLoad}
          onHistoricalRaceClear={onHistoricalRaceClear}
        />
      )}
    </div>
  );
}

function HistoricalAnalysisSection({
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

function HistoricalDataNotice({
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

function HistoricalDatasetManager({
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

function TacticsStat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className={`stat-panel tactics-stat${tone ? ` tactics-stat--${tone}` : ''}`}>
      <span className="muted-label">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function TacticsSectionHeader({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return (
    <div className="analysis-section-header">
      <span className="page-kicker">{kicker}</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function RaceProgressChart({
  points,
  showLive = false,
  showTarget = false,
  ownLabel = 'Apolloon vorig jaar',
  rivalLabel = 'VTK vorig jaar',
}: {
  points: RaceProgressPoint[];
  showLive?: boolean;
  showTarget?: boolean;
  ownLabel?: string;
  rivalLabel?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const datasets: ChartConfiguration<'line'>['data']['datasets'] = [];
    if (showLive) datasets.push(lineDataset('Apolloon live', points, 'liveLaps', '#2877F6', 4));
    if (showTarget) datasets.push(lineDataset('Doelverloop', points, 'targetLaps', '#111827', 2, [8, 6]));
    datasets.push(lineDataset(ownLabel, points, 'ownHistoricalLaps', '#7c3aed', 2));
    datasets.push(lineDataset(rivalLabel, points, 'rivalHistoricalLaps', '#d59d00', 2));

    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: sharedLineChartOptions('Cumulatieve rondes', (value) => `${Math.round(Number(value))}`),
    });
    return () => chart.destroy();
  }, [ownLabel, points, rivalLabel, showLive, showTarget]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

function HourlyPaceChart({
  points,
  showPlan = false,
  showActual = false,
  ownLabel = 'Apolloon vorig jaar',
  rivalLabel = 'VTK vorig jaar',
}: {
  points: HourlyPacePoint[];
  showPlan?: boolean;
  showActual?: boolean;
  ownLabel?: string;
  rivalLabel?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const datasets: ChartConfiguration<'line'>['data']['datasets'] = [];
    if (showActual) datasets.push(paceDataset('Werkelijk live', points, 'actualSeconds', '#2877F6', 4));
    if (showPlan) datasets.push(paceDataset('Doeltempo', points, 'plannedSeconds', '#111827', 2, [8, 6]));
    datasets.push(paceDataset(ownLabel, points, 'ownHistoricalSeconds', '#7c3aed', 2));
    datasets.push(paceDataset(rivalLabel, points, 'rivalHistoricalSeconds', '#d59d00', 2));

    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: sharedLineChartOptions('Mediaan rondetijd', (value) => formatPaceSeconds(Number(value))),
    });
    return () => chart.destroy();
  }, [ownLabel, points, rivalLabel, showActual, showPlan]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

function LiveTrendChart({ points }: { points: LiveTrendPoint[] }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const trendDataset = (
      label: string,
      valueKey: keyof Pick<LiveTrendPoint, 'liveSeconds' | 'ownHistoricalSeconds' | 'rivalHistoricalSeconds'>,
      color: string,
      borderWidth: number,
      borderDash?: number[]
    ) => ({
      label,
      data: points.map((point) => ({ x: point.raceHour, y: point[valueKey] })),
      borderColor: color,
      backgroundColor: color,
      borderWidth,
      borderDash,
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.28,
      spanGaps: true,
    });
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          trendDataset('Apolloon live', 'liveSeconds', '#2877F6', 4),
          trendDataset('Apolloon vorig jaar', 'ownHistoricalSeconds', '#7c3aed', 2, [7, 5]),
          trendDataset('VTK vorig jaar', 'rivalHistoricalSeconds', '#d59d00', 2, [7, 5]),
        ],
      },
      options: sharedLineChartOptions('Mediaan rondetijd per kwartier', (value) => formatPaceSeconds(Number(value))),
    });
    return () => chart.destroy();
  }, [points]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

function LiveTimeGapChart({ points }: { points: TimeGapPoint[] }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const actualPoints = points.filter((point) => !point.predicted);
    const predictionPoints = points.filter((point) => point.predicted);
    const lastActualPoint = actualPoints[actualPoints.length - 1];
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Werkelijke tijdskloof',
            data: actualPoints.map((point) => ({ x: point.raceHour, y: point.gapSeconds })),
            borderColor: '#172033',
            backgroundColor: '#172033',
            borderWidth: 3,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'Voorspeld met doelschema',
            data: [...(lastActualPoint ? [lastActualPoint] : []), ...predictionPoints]
              .map((point) => ({ x: point.raceHour, y: point.gapSeconds })),
            borderColor: '#2877F6',
            backgroundColor: '#2877F6',
            borderWidth: 3,
            borderDash: [8, 6],
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'Gelijke stand',
            data: [{ x: 0, y: 0 }, { x: 24, y: 0 }],
            borderColor: '#94a3b8',
            backgroundColor: '#94a3b8',
            borderWidth: 1,
            borderDash: [5, 5],
            pointRadius: 0,
          },
        ],
      },
      options: sharedLineChartOptions('Tijdskloof op VTK', (value) => `${Number(value) > 0 ? '+' : ''}${Math.round(Number(value))}s`),
    });
    return () => chart.destroy();
  }, [points]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

function ChartCanvas({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  return (
    <div className="analysis-chart-card tactics-chart-card">
      <canvas ref={canvasRef} />
    </div>
  );
}

function RecentLapsTable({
  laps,
  minimumLapSeconds,
  maximumLapSeconds,
}: {
  laps: LapRecord[];
  minimumLapSeconds: number;
  maximumLapSeconds: number;
}) {
  const sortedLaps = [...laps].sort((firstLap, secondLap) => secondLap.finishedAt - firstLap.finishedAt);
  const recentLaps = sortedLaps.slice(0, 30);
  const suspiciousLaps = sortedLaps.filter((lap) => {
    const durationSeconds = lap.durationMs / 1_000;
    return durationSeconds < minimumLapSeconds || durationSeconds > maximumLapSeconds;
  });
  return (
    <div className="tactics-lap-tables">
      <LapReviewTable laps={recentLaps} minimumLapSeconds={minimumLapSeconds} maximumLapSeconds={maximumLapSeconds} />
      {suspiciousLaps.length > 0 && (
        <details className="tactics-suspicious-details">
          <summary>Alle {suspiciousLaps.length} verdachte rondes bekijken</summary>
          <LapReviewTable laps={suspiciousLaps} minimumLapSeconds={minimumLapSeconds} maximumLapSeconds={maximumLapSeconds} />
        </details>
      )}
    </div>
  );
}

function LapReviewTable({
  laps,
  minimumLapSeconds,
  maximumLapSeconds,
}: {
  laps: LapRecord[];
  minimumLapSeconds: number;
  maximumLapSeconds: number;
}) {
  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead><tr><th>Moment</th><th>Loper</th><th>Ronde</th><th>Tijd</th><th>Controle</th></tr></thead>
        <tbody>
          {laps.map((lap) => {
            const durationSeconds = lap.durationMs / 1_000;
            const suspicious = durationSeconds < minimumLapSeconds || durationSeconds > maximumLapSeconds;
            return (
              <tr key={lap.id}>
                <td>{formatClockTimeMs(lap.finishedAt)}</td>
                <td><strong>{lap.runnerName}</strong></td>
                <td>{lap.lapNumber}</td>
                <td>{formatDurationMs(lap.durationMs)}</td>
                <td><span className={`tactics-lap-status tactics-lap-status--${suspicious ? 'warning' : 'valid'}`}>{suspicious ? 'Nakijken' : 'Geldig'}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function lineDataset(
  label: string,
  points: RaceProgressPoint[],
  valueKey: keyof Pick<RaceProgressPoint, 'liveLaps' | 'targetLaps' | 'ownHistoricalLaps' | 'rivalHistoricalLaps'>,
  color: string,
  borderWidth: number,
  borderDash?: number[]
) {
  return {
    label,
    data: points.map((point) => ({ x: point.raceHour, y: point[valueKey] })),
    borderColor: color,
    backgroundColor: color,
    borderWidth,
    borderDash,
    pointRadius: 0,
    pointHoverRadius: 5,
    tension: 0.18,
    spanGaps: false,
  };
}

function paceDataset(
  label: string,
  points: HourlyPacePoint[],
  valueKey: keyof Pick<HourlyPacePoint, 'plannedSeconds' | 'actualSeconds' | 'ownHistoricalSeconds' | 'rivalHistoricalSeconds'>,
  color: string,
  borderWidth: number,
  borderDash?: number[]
) {
  return {
    label,
    data: points.map((point) => ({ x: point.raceHour + 0.5, y: point[valueKey] })),
    borderColor: color,
    backgroundColor: color,
    borderWidth,
    borderDash,
    pointRadius: 3,
    pointHoverRadius: 6,
    tension: 0.25,
    spanGaps: false,
  };
}

function sharedLineChartOptions(
  yAxisTitle: string,
  yTickFormatter: (value: string | number) => string
): ChartConfiguration<'line'>['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, MAX_CHART_PIXEL_RATIO),
    interaction: { mode: 'nearest', intersect: false },
    parsing: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 14, color: '#162033', font: { weight: 'bold' } } },
      tooltip: {
        callbacks: {
          title(items) { return items[0] ? `Race-uur ${formatRaceHour(Number(items[0].parsed.x))}` : ''; },
          label(context) {
            return context.parsed.y == null
              ? `${context.dataset.label}: geen data`
              : `${context.dataset.label}: ${yTickFormatter(context.parsed.y)}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: RACE_DURATION_HOURS,
        title: { display: true, text: 'Uren sinds de start', color: '#64748b', font: { weight: 'bold' } },
        ticks: { color: '#64748b', stepSize: 2, callback: (value) => `${value}u` },
        grid: { color: '#eef2f7' },
      },
      y: {
        beginAtZero: yAxisTitle === 'Cumulatieve rondes',
        title: { display: true, text: yAxisTitle, color: '#64748b', font: { weight: 'bold' } },
        ticks: { color: '#64748b', callback: (value) => yTickFormatter(value) },
        grid: { color: '#e2e8f0' },
      },
    },
  };
}

function loadStoredHistoricalRace(): HistoricalRace | null {
  const storedJson = localStorage.getItem(HISTORICAL_RACE_STORAGE_KEY);
  if (!storedJson) return null;
  try {
    return parseHistoricalRace(storedJson);
  } catch {
    localStorage.removeItem(HISTORICAL_RACE_STORAGE_KEY);
    localStorage.removeItem(HISTORICAL_RACE_NAME_STORAGE_KEY);
    return null;
  }
}

function loadStoredTacticsScenario(): StoredTacticsScenario | null {
  const storedJson = localStorage.getItem(TACTICS_SCENARIO_STORAGE_KEY);
  if (!storedJson) return null;
  try {
    const storedScenario = JSON.parse(storedJson) as Partial<StoredTacticsScenario>;
    if (
      typeof storedScenario.targetLaps !== 'number'
      || !Number.isFinite(storedScenario.targetLaps)
      || storedScenario.targetLaps < 1
      || !['flat', 'apolloon', 'vtk'].includes(storedScenario.targetProfile ?? '')
      || !Array.isArray(storedScenario.targetPaces)
      || storedScenario.targetPaces.length !== RACE_DURATION_HOURS
      || storedScenario.targetPaces.some((pace) => typeof pace !== 'number' || !Number.isFinite(pace) || pace <= 0)
    ) {
      throw new Error('Ongeldig opgeslagen scenario.');
    }
    return storedScenario as StoredTacticsScenario;
  } catch {
    localStorage.removeItem(TACTICS_SCENARIO_STORAGE_KEY);
    return null;
  }
}

function formatPaceSeconds(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'Geen data';
  return formatDurationMs(seconds * 1_000);
}

function formatRaceHour(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${wholeHours}u${String(minutes).padStart(2, '0')}` : `${wholeHours}u`;
}

function formatRaceHourWindow(raceStartedAt: number, raceHour: number): string {
  const formatter = new Intl.DateTimeFormat('nl-BE', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Brussels',
  });
  const startedAt = raceStartedAt + raceHour * 3_600_000;
  return `${formatter.format(startedAt)}-${formatter.format(startedAt + 3_600_000)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function standardDeviation(values: number[]): number {
  if (!values.length) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}
