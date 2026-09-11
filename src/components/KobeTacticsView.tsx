import React from 'react';
import { SectionNavigation } from './SectionNavigation';
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
import { HistoricalAnalysisSection, HistoricalDataNotice, HistoricalDatasetManager } from './tactics/HistoricalPanels';
import {
  APOLLOON_TEAM_ID,
  BUNDLED_REFERENCE_NAME,
  BUNDLED_REFERENCE_URL,
  DEFAULT_TARGET_LAPS,
  HISTORICAL_RACE_NAME_STORAGE_KEY,
  HISTORICAL_RACE_STORAGE_KEY,
  TACTICS_SCENARIO_STORAGE_KEY,
  VTK_TEAM_ID,
  clamp,
  formatPaceSeconds,
  formatRaceHour,
  formatRaceHourWindow,
  loadStoredHistoricalRace,
  loadStoredTacticsScenario,
  standardDeviation,
  type StoredTacticsScenario,
  type TargetProfile,
} from './tactics/tacticsFormat';
import {
  HourlyPaceChart,
  LiveTimeGapChart,
  LiveTrendChart,
  RaceProgressChart,
  TacticsSectionHeader,
  TacticsStat,
} from './tactics/tacticsCharts';
import { RecentLapsTable } from './tactics/tacticsTables';

type TacticsSection = 'live' | 'historical';

const selectTacticsData = ({ race }: LiveAppSnapshot) => ({ race });

export function KobeTacticsView() {
  const { race } = useAppData(selectTacticsData);
  useClockTick(30_000, race.raceStartedAt != null && race.raceFinishedAt == null);
  const { laps, loading: historyLoading, error: historyError } = useRaceHistory({ scope: 'full' });
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
          setHistoricalError(
            error instanceof Error ? error.message : 'De Quivr-referentie kon niet worden geladen.'
          );
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

      <SectionNavigation
        label="Tactiekonderdeel"
        sections={[
          { id: 'live', label: 'Live race & doelverloop' },
          { id: 'historical', label: 'Analyse vorig jaar' },
        ] as const}
        activeSectionId={section}
        onSectionChange={setSection}
      />

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
          unit="rondes"
          detail={`${expectedLapsNow.toFixed(1)} rondes verwacht`}
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
          unit="rondes"
          detail={`Bron: ${historicalSourceName}`}
        />
        <TacticsStat
          label="Vs. VTK vorig jaar"
          value={formatSignedLapDifference(rivalHistoricalLapsNow == null ? null : cleanLaps.length - rivalHistoricalLapsNow)}
          unit="rondes"
          detail={`Bron: ${historicalSourceName}`}
        />
      </section>

      <div className="tactics-planning-layout">
      <section className="panel tactics-forecast">
        <TacticsSectionHeader
          kicker="Voortgang"
          title="Live tegenover doel en vorig jaar"
          text="Elke nieuwe ronde uit het telsysteem wordt automatisch toegevoegd. De stippellijn toont het gekozen doelverloop tot het einde van de race. De vorig-jaarlijnen staan standaard uit; klik op de legenda om ze te tonen."
        />
        <RaceProgressChart points={progressPoints} showLive showTarget />
      </section>

      <section className="panel tactics-scenario-panel">
        <TacticsSectionHeader
          kicker="Scenario"
          title="Doelverloop simuleren"
          text="Kies een einddoel en gebruik een vlak tempo of het dag-nachtverloop van vorig jaar als vertrekpunt. Pas daarna elk uur afzonderlijk aan."
        />
        <div className="tactics-control-grid">
          <p className="tactics-group-label">Doelstelling</p>
          <label>
            <span>Doel na 24 uur · gem. {formatPaceSeconds(86_400 / targetLaps)}</span>
            <input
              className="input tactics-goal-input"
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
          <p className="tactics-group-label">Filter voor tempo</p>
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

        <details className="tactics-hour-editor">
          <summary>Doeltempo per uur aanpassen</summary>
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
        </details>
      </section>

      </div>

      <details className="tactics-analysis-details">
        <summary>Tempotrends, vergelijking &amp; rondecontrole</summary>
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

      </details>

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
