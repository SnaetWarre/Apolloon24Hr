import { workspaceChartPalette } from '../../lib/chartPalette';
import React from 'react';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { HistoricalRace, HistoricalTeam } from '../../lib/tactics';
import {
  analyzeDrafting,
  buildBreakEvenSensitivity,
  buildHalfHourPaceDifferences,
  buildHourlyConsistency,
  buildHourlyLapGains,
  buildQuarterHourPaces,
  buildRaceLeadCurve,
  buildSameLapIndexGap,
  buildTimeGapCurve,
  calculateBreakEven,
  calculateNightPenalty,
  defaultSlowLapThreshold,
  findPaceChanges,
  findSlowLaps,
  smoothPacePoints,
  summarizeHistoricalTeams,
  summarizeHistoricalWindow,
  type DraftingTeamAnalysis,
  type PacePoint,
} from '../../lib/tacticsDeepDive';
import { formatDurationMs } from '../../lib/time';

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip
);

type DeepDiveSection = 'overview' | 'tempo' | 'race' | 'diagnostics' | 'drafting';

const SECTION_OPTIONS: ReadonlyArray<{ id: DeepDiveSection; label: string; detail: string }> = [
  { id: 'overview', label: 'Alle teams', detail: 'Rangschikking en spreiding' },
  { id: 'tempo', label: 'Tempo A vs. B', detail: 'Kwartieren, consistentie en nacht' },
  { id: 'race', label: 'Raceverloop', detail: 'Tijdskloof en gewonnen rondes' },
  { id: 'diagnostics', label: 'Diagnostiek', detail: 'Trage rondes en break-even' },
  { id: 'drafting', label: 'Volgeffect', detail: 'Nabijheid en statistiek' },
];

export function HistoricalDeepDive({
  historicalRace,
  firstTeam,
  secondTeam,
}: {
  historicalRace: HistoricalRace;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  const [section, setSection] = React.useState<DeepDiveSection>('overview');

  return (
    <>
      <nav className="tactics-deep-nav" aria-label="Verdiepende historische analyse">
        {SECTION_OPTIONS.map((option) => (
          <button
            key={option.id}
            className={section === option.id ? 'is-active' : ''}
            aria-pressed={section === option.id}
            onClick={() => setSection(option.id)}
          >
            <strong>{option.label}</strong>
            <small>{option.detail}</small>
          </button>
        ))}
      </nav>

      {section === 'overview' && (
        <OverviewSection historicalRace={historicalRace} firstTeam={firstTeam} secondTeam={secondTeam} />
      )}
      {section === 'tempo' && <TempoSection firstTeam={firstTeam} secondTeam={secondTeam} />}
      {section === 'race' && <RaceSection firstTeam={firstTeam} secondTeam={secondTeam} />}
      {section === 'diagnostics' && <DiagnosticsSection firstTeam={firstTeam} secondTeam={secondTeam} />}
      {section === 'drafting' && <DraftingSection firstTeam={firstTeam} secondTeam={secondTeam} />}
    </>
  );
}

function OverviewSection({
  historicalRace,
  firstTeam,
  secondTeam,
}: {
  historicalRace: HistoricalRace;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  const summaries = React.useMemo(() => summarizeHistoricalTeams(historicalRace), [historicalRace]);
  const [detailTeamId, setDetailTeamId] = React.useState(firstTeam.teamId);
  const firstSummary = summaries.find((summary) => summary.teamId === firstTeam.teamId)!;
  const secondSummary = summaries.find((summary) => summary.teamId === secondTeam.teamId)!;
  const detailTeam = historicalRace.teams.find((team) => team.teamId === detailTeamId) ?? firstTeam;

  return (
    <div className="tactics-section-stack">
      <section className="stats-grid stats-grid--analysis tactics-live-stats" aria-label="Historische kerncijfers">
        <DeepStat label={`Team ${firstTeam.teamId}`} value={`${firstSummary.laps} rondes`} detail={`Mediaan ${formatSeconds(firstSummary.medianSeconds)}`} />
        <DeepStat label={`Team ${secondTeam.teamId}`} value={`${secondSummary.laps} rondes`} detail={`Mediaan ${formatSeconds(secondSummary.medianSeconds)}`} />
        <DeepStat label="Verschil na 24u" value={signedNumber(firstSummary.laps - secondSummary.laps)} detail={`Team ${firstTeam.teamId} tegenover team ${secondTeam.teamId}`} />
        <DeepStat
          label="Meest consistent"
          value={`Team ${firstSummary.standardDeviationSeconds <= secondSummary.standardDeviationSeconds ? firstTeam.teamId : secondTeam.teamId}`}
          detail="Laagste spreiding over alle rondes"
        />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Volledig deelnemersveld"
          title="Alle teams naast elkaar"
          text="Rangschikking op aantal rondes, met de mediaan, P10-P90-band en standaardafwijking van de rondetijden."
        />
        <div className="table-wrap">
          <table className="analysis-table tactics-ranking-table">
            <thead>
              <tr><th>#</th><th>Team</th><th>Rondes</th><th>Mediaan</th><th>P10-P90</th><th>Spreiding</th></tr>
            </thead>
            <tbody>
              {summaries.map((summary, index) => (
                <tr
                  key={summary.teamId}
                  className={summary.teamId === firstTeam.teamId || summary.teamId === secondTeam.teamId ? 'is-selected' : ''}
                >
                  <td>{index + 1}</td>
                  <td><span className="tactics-team-key"><i style={{ background: teamColor(summary.teamId, index) }} />Team {summary.teamId}</span></td>
                  <td><strong>{summary.laps}</strong></td>
                  <td>{formatSeconds(summary.medianSeconds)}</td>
                  <td>{formatSeconds(summary.p10Seconds)} tot {formatSeconds(summary.p90Seconds)}</td>
                  <td>{summary.standardDeviationSeconds.toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="tactics-panel-heading">
          <SectionHeader
            kicker="Rondeduur over 24 uur"
            title={`Alle passages van team ${detailTeam.teamId}`}
            text="Elke stip is een geregistreerde ronde. De donkere lijn is de lopende mediaan over twintig rondes, zoals in Kobe zijn oorspronkelijke analyse."
          />
          <label className="tactics-compact-select">
            <span>Team in detail</span>
            <select className="input" value={detailTeam.teamId} onChange={(event) => setDetailTeamId(Number(event.target.value))}>
              {historicalRace.teams.map((team) => <option key={team.teamId} value={team.teamId}>Team {team.teamId}</option>)}
            </select>
          </label>
        </div>
        <TeamLapTimelineChart team={detailTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Verdeling"
          title={`Rondetijdfrequentie van team ${firstTeam.teamId} en team ${secondTeam.teamId}`}
          text="Aantal rondes per interval van twee seconden. Zo ziet ge niet alleen het gemiddelde, maar ook de volledige vorm en uitschieters."
        />
        <DurationDistributionChart firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>
    </div>
  );
}

function TempoSection({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const [startHour, setStartHour] = React.useState(0);
  const [endHour, setEndHour] = React.useState(24);
  const [nightStartHour, setNightStartHour] = React.useState(3);
  const [nightEndHour, setNightEndHour] = React.useState(9);
  const quarterPaces = React.useMemo(
    () => buildQuarterHourPaces(firstTeam, secondTeam, startHour, endHour),
    [endHour, firstTeam, secondTeam, startHour]
  );
  const smoothedPaces = React.useMemo(() => smoothPacePoints(quarterPaces), [quarterPaces]);
  const consistency = React.useMemo(
    () => buildHourlyConsistency(firstTeam, secondTeam),
    [firstTeam, secondTeam]
  );
  const halfHourDifferences = React.useMemo(
    () => buildHalfHourPaceDifferences(firstTeam, secondTeam, startHour, endHour),
    [endHour, firstTeam, secondTeam, startHour]
  );
  const firstPenalty = calculateNightPenalty(firstTeam, nightStartHour, nightEndHour);
  const secondPenalty = calculateNightPenalty(secondTeam, nightStartHour, nightEndHour);
  const firstDistribution = summarizeHistoricalWindow(firstTeam, startHour, endHour);
  const secondDistribution = summarizeHistoricalWindow(secondTeam, startHour, endHour);

  return (
    <div className="tactics-section-stack">
      <section className="panel tactics-inline-controls">
        <SectionHeader
          kicker="Vergelijkingsvenster"
          title="Tempo in detail"
          text="Beperk de kwartieranalyse of pas het nachtvenster aan. De consistentie blijft steeds over de volledige race berekend."
        />
        <div className="tactics-control-grid">
          <NumberControl label="Van race-uur" value={startHour} min={0} max={endHour - 1} onChange={setStartHour} />
          <NumberControl label="Tot race-uur" value={endHour} min={startHour + 1} max={24} onChange={setEndHour} />
          <NumberControl label="Nacht vanaf" value={nightStartHour} min={0} max={nightEndHour - 1} onChange={setNightStartHour} />
          <NumberControl label="Nacht tot" value={nightEndHour} min={nightStartHour + 1} max={24} onChange={setNightEndHour} />
        </div>
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Kwartiertrend"
          title="Mediaan rondetijd per kwartier"
          text="Meer detail dan de uurblokken: korte versnellingen, terugval en kantelpunten worden afzonderlijk zichtbaar."
        />
        <PaceComparisonChart points={quarterPaces} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Gesmooth verloop"
          title="Langere tempotrend zonder rondepieken"
          text="Een lopend venster van ongeveer drie uur maakt de structurele versnelling of terugval zichtbaar, los van korte wisselmomenten."
        />
        <PaceComparisonChart points={smoothedPaces} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Onderling verschil"
          title="Verschil in gemiddeld tempo per halfuur"
          text={`Positief betekent dat team ${firstTeam.teamId} trager was; negatief betekent dat team ${firstTeam.teamId} sneller was dan team ${secondTeam.teamId}.`}
        />
        <HalfHourDifferenceChart points={halfHourDifferences} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Verdeling in het gekozen venster"
          title="Frequentie, IQR en uitschieters"
          text="De frequentie gebruikt intervallen van twee seconden. IQR is de breedte van de middelste helft van alle rondetijden."
        />
        <div className="table-wrap tactics-summary-table">
          <table>
            <thead><tr><th>Team</th><th>Rondes</th><th>Mediaan</th><th>IQR</th><th>Uitschieters</th></tr></thead>
            <tbody>
              <DistributionRow team={firstTeam} summary={firstDistribution} />
              <DistributionRow team={secondTeam} summary={secondDistribution} />
            </tbody>
          </table>
        </div>
        <WindowFrequencyChart firstTeam={firstTeam} secondTeam={secondTeam} startHour={startHour} endHour={endHour} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Consistentie"
          title="Mediaan en P10-P90-spreiding per uur"
          text="De volle lijn is het typische tempo. De stippellijn toont hoe breed de snelle en trage rondes binnen elk uur uiteenlagen."
        />
        <ConsistencyChart points={consistency} firstTeam={firstTeam} secondTeam={secondTeam} />
        <StandardDeviationChart points={consistency} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="stats-grid stats-grid--analysis tactics-live-stats">
        <NightPenaltyStat team={firstTeam} penalty={firstPenalty} />
        <NightPenaltyStat team={secondTeam} penalty={secondPenalty} />
      </section>
    </div>
  );
}

function RaceSection({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const [lapLengthMeters, setLapLengthMeters] = React.useState(530);
  const timeGap = React.useMemo(() => buildTimeGapCurve(firstTeam, secondTeam), [firstTeam, secondTeam]);
  const hourlyGains = React.useMemo(() => buildHourlyLapGains(firstTeam, secondTeam), [firstTeam, secondTeam]);
  const raceLead = React.useMemo(() => buildRaceLeadCurve(firstTeam, secondTeam), [firstTeam, secondTeam]);
  const sameLapGap = React.useMemo(() => buildSameLapIndexGap(firstTeam, secondTeam), [firstTeam, secondTeam]);
  const finalLapGap = secondTeam.cumulativeLapTimesMs.length - firstTeam.cumulativeLapTimesMs.length;
  const finalTimeGap = timeGap[timeGap.length - 1]?.gapSeconds ?? 0;

  return (
    <div className="tactics-section-stack">
      <section className="stats-grid stats-grid--analysis tactics-live-stats">
        <DeepStat
          label={`Tijdskloof team ${firstTeam.teamId}`}
          value={formatSignedSeconds(finalTimeGap)}
          detail={`Positief betekent achter op team ${secondTeam.teamId}`}
        />
        <DeepStat label="Rondeverschil" value={signedNumber(-finalLapGap)} detail={`Team ${firstTeam.teamId} tegenover team ${secondTeam.teamId}`} />
        <DeepStat label="Afstandsverschil" value={`${signedNumber(-finalLapGap * lapLengthMeters)} m`} detail={`${lapLengthMeters} meter per ronde`} />
        <label className="stat-panel tactics-stat tactics-stat--control">
          <span className="muted-label">Rondelengte</span>
          <input type="number" min={1} step={10} value={lapLengthMeters} onChange={(event) => setLapLengthMeters(Math.max(1, Number(event.target.value) || 1))} />
          <small>meter</small>
        </label>
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Tijdsachterstand"
          title={`Hoeveel tijd lag team ${firstTeam.teamId} voor of achter?`}
          text={`Benaderde tijd om op elk moment dezelfde voortgang als team ${secondTeam.teamId} te halen. Positief is achterstand.`}
        />
        <TimeGapChart points={timeGap} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Dezelfde ronde-index"
          title="Tijdsverschil bij exact dezelfde ronde"
          text={`Vergelijkt ronde 1 met ronde 1, ronde 2 met ronde 2 enzovoort. Positief betekent dat team ${firstTeam.teamId} die ronde-index later bereikte.`}
        />
        <SameLapGapChart points={sameLapGap} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Uur per uur"
          title={`Gewonnen of verloren rondes tegenover team ${secondTeam.teamId}`}
          text="Een positieve balk betekent dat team B dat uur meer rondes liep; negatief betekent winst voor team A."
        />
        <HourlyGainChart points={hourlyGains} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Cumulatief"
          title="Ronden over de volledige race"
          text="De staplijnen tonen elk geregistreerd passeermoment, zodat leiderswissels tot op rondeniveau zichtbaar blijven."
        />
        <CumulativeRaceChart firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Leiderschap en afstand"
          title="Wie lag wanneer voor?"
          text={`Boven nul lag team ${firstTeam.teamId} voor, onder nul team ${secondTeam.teamId}. De tweede as rekent hetzelfde verschil om met ${lapLengthMeters} meter per ronde.`}
        />
        <RaceLeadChart points={raceLead} firstTeam={firstTeam} secondTeam={secondTeam} lapLengthMeters={lapLengthMeters} />
      </section>
    </div>
  );
}

function DiagnosticsSection({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const suggestedThreshold = React.useMemo(() => defaultSlowLapThreshold(firstTeam, secondTeam), [firstTeam, secondTeam]);
  const [slowThresholdSeconds, setSlowThresholdSeconds] = React.useState(suggestedThreshold);
  const [paceChangeThresholdSeconds, setPaceChangeThresholdSeconds] = React.useState(8);
  const [improvingTeamId, setImprovingTeamId] = React.useState(firstTeam.teamId);
  const [maximumImprovementSeconds, setMaximumImprovementSeconds] = React.useState(15);

  React.useEffect(() => setSlowThresholdSeconds(suggestedThreshold), [suggestedThreshold]);
  React.useEffect(() => setImprovingTeamId(firstTeam.teamId), [firstTeam.teamId, secondTeam.teamId]);

  const firstSlowLaps = findSlowLaps(firstTeam, slowThresholdSeconds);
  const secondSlowLaps = findSlowLaps(secondTeam, slowThresholdSeconds);
  const firstChanges = findPaceChanges(firstTeam, paceChangeThresholdSeconds);
  const secondChanges = findPaceChanges(secondTeam, paceChangeThresholdSeconds);
  const improvingTeam = improvingTeamId === firstTeam.teamId ? firstTeam : secondTeam;
  const targetTeam = improvingTeamId === firstTeam.teamId ? secondTeam : firstTeam;
  const breakEven = calculateBreakEven(improvingTeam, targetTeam);
  const sensitivity = buildBreakEvenSensitivity(improvingTeam, maximumImprovementSeconds);

  return (
    <div className="tactics-section-stack">
      <section className="panel tactics-inline-controls">
        <SectionHeader
          kicker="Detectie-instellingen"
          title="Zoek de verliesmomenten"
          text="Trage rondes zijn absolute uitschieters. Vermoedelijke wisselingen zijn plotse afwijkingen tegenover de vijf vorige rondes."
        />
        <div className="tactics-control-grid">
          <NumberControl label="Trage ronde vanaf" suffix="s" value={slowThresholdSeconds} min={10} max={300} onChange={setSlowThresholdSeconds} />
          <NumberControl label="Temposprong vanaf" suffix="s" value={paceChangeThresholdSeconds} min={1} max={60} onChange={setPaceChangeThresholdSeconds} />
        </div>
      </section>

      <section className="stats-grid stats-grid--analysis tactics-live-stats">
        <DeepStat label={`Trage rondes team ${firstTeam.teamId}`} value={String(firstSlowLaps.length)} detail={`${percentage(firstSlowLaps.length, firstTeam.lapDurationsMs.length)} boven de grens`} />
        <DeepStat label={`Trage rondes team ${secondTeam.teamId}`} value={String(secondSlowLaps.length)} detail={`${percentage(secondSlowLaps.length, secondTeam.lapDurationsMs.length)} boven de grens`} />
        <DeepStat label={`Temposprongen team ${firstTeam.teamId}`} value={String(firstChanges.length)} detail={`Meer dan ${paceChangeThresholdSeconds}s verschil`} />
        <DeepStat label={`Temposprongen team ${secondTeam.teamId}`} value={String(secondChanges.length)} detail={`Meer dan ${paceChangeThresholdSeconds}s verschil`} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Verliesmomenten op de klok"
          title="Trage rondes en plotse temposprongen"
          text="De gemarkeerde punten koppelen de diagnose terug aan het exacte racemoment. Zo kunt ge zien of problemen samenklonteren rond wissels of bepaalde uren."
        />
        <DiagnosticTimelineChart
          firstTeam={firstTeam}
          secondTeam={secondTeam}
          firstSlowLaps={firstSlowLaps}
          secondSlowLaps={secondSlowLaps}
          firstChanges={firstChanges}
          secondChanges={secondChanges}
        />
      </section>

      <section className="panel tactics-diagnostic-grid">
        <DiagnosticTable title={`Grootste trage rondes team ${firstTeam.teamId}`} laps={firstSlowLaps.slice(0, 10)} />
        <DiagnosticTable title={`Grootste trage rondes team ${secondTeam.teamId}`} laps={secondSlowLaps.slice(0, 10)} />
        <PaceChangeTable title={`Sterkste temposprongen team ${firstTeam.teamId}`} changes={firstChanges.slice(0, 10)} />
        <PaceChangeTable title={`Sterkste temposprongen team ${secondTeam.teamId}`} changes={secondChanges.slice(0, 10)} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="What-if"
          title="Break-even calculator"
          text="Bereken hoeveel sneller één team gemiddeld had moeten lopen om het aantal rondes van het andere team te halen."
        />
        <div className="tactics-control-grid tactics-break-even-controls">
          <label>
            <span>Welk team verbetert?</span>
            <select className="input" value={improvingTeamId} onChange={(event) => setImprovingTeamId(Number(event.target.value))}>
              <option value={firstTeam.teamId}>Team {firstTeam.teamId}</option>
              <option value={secondTeam.teamId}>Team {secondTeam.teamId}</option>
            </select>
          </label>
          <NumberControl label="Maximale verbetering" suffix="s" value={maximumImprovementSeconds} min={1} max={60} step={0.5} onChange={setMaximumImprovementSeconds} />
          {breakEven && (
            <div className="tactics-break-even-result">
              <span>{breakEven.improvementSeconds > 0 ? 'Benodigd voor break-even' : 'Break-even al gehaald'}</span>
              <strong>{formatSeconds(breakEven.requiredAverageSeconds)}</strong>
              <small>
                {breakEven.improvementSeconds > 0
                  ? `${breakEven.improvementSeconds.toFixed(1)}s of ${breakEven.improvementPercent.toFixed(1)}% sneller per ronde`
                  : `${Math.abs(breakEven.improvementSeconds).toFixed(1)}s per ronde sneller dan nodig`}
              </small>
            </div>
          )}
        </div>
        <BreakEvenChart points={sensitivity} targetLaps={targetTeam.cumulativeLapTimesMs.length} teamId={improvingTeam.teamId} />
      </section>
    </div>
  );
}

function DraftingSection({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const [startHour, setStartHour] = React.useState(0);
  const [endHour, setEndHour] = React.useState(24);
  const [closeSeconds, setCloseSeconds] = React.useState(8);
  const [farSeconds, setFarSeconds] = React.useState(15);
  const [minimumLapSeconds, setMinimumLapSeconds] = React.useState(55);
  const [maximumLapSeconds, setMaximumLapSeconds] = React.useState(140);
  const options = React.useMemo(() => ({
    startHour,
    endHour,
    closeSeconds,
    farSeconds,
    minimumLapSeconds,
    maximumLapSeconds,
  }), [closeSeconds, endHour, farSeconds, maximumLapSeconds, minimumLapSeconds, startHour]);
  const firstAnalysis = React.useMemo(() => analyzeDrafting(firstTeam, secondTeam, options), [firstTeam, options, secondTeam]);
  const secondAnalysis = React.useMemo(() => analyzeDrafting(secondTeam, firstTeam, options), [firstTeam, options, secondTeam]);

  return (
    <div className="tactics-section-stack">
      <section className="panel tactics-inline-controls">
        <SectionHeader
          kicker="Volgeffect"
          title="Loopt een team sneller vlak bij het andere team?"
          text="Elke passage wordt gekoppeld aan de dichtstbijzijnde passage van het andere team. De rangsomtoets vergelijkt dichtbij, chasing, leading en ver weg."
        />
        <div className="tactics-control-grid tactics-control-grid--drafting">
          <NumberControl label="Van race-uur" value={startHour} min={0} max={endHour - 1} onChange={setStartHour} />
          <NumberControl label="Tot race-uur" value={endHour} min={startHour + 1} max={24} onChange={setEndHour} />
          <NumberControl label="Dichtbij tot" suffix="s" value={closeSeconds} min={1} max={farSeconds - 1} onChange={setCloseSeconds} />
          <NumberControl label="Ver weg vanaf" suffix="s" value={farSeconds} min={closeSeconds + 1} max={120} onChange={setFarSeconds} />
          <NumberControl label="Minimum ronde" suffix="s" value={minimumLapSeconds} min={1} max={maximumLapSeconds - 1} onChange={setMinimumLapSeconds} />
          <NumberControl label="Maximum ronde" suffix="s" value={maximumLapSeconds} min={minimumLapSeconds + 1} max={300} onChange={setMaximumLapSeconds} />
        </div>
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Passages"
          title="Rondetijd volgens positie tegenover de andere ploeg"
          text="Elke stip is één passage. Links van nul liep het team voor, rechts van nul liep het achter op de dichtstbijzijnde passage."
        />
        <DraftingScatterChart firstAnalysis={firstAnalysis} secondAnalysis={secondAnalysis} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Nabijheidsgradiënt"
          title="Mediaan rondetijd volgens afstand tot de andere ploeg"
          text="Een lagere mediaan in de dichtste categorieën wijst op een mogelijk volgeffect. Categorieën met minder dan vier rondes worden niet als mediaan getoond."
        />
        <DraftingProximityChart firstAnalysis={firstAnalysis} secondAnalysis={secondAnalysis} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Statistische toets"
          title="Wilcoxon-rangsom met tiecorrectie"
          text="p < 0,05 is statistisch significant. Een positief effect betekent dat de eerste genoemde situatie sneller was dan de tweede."
        />
        <DraftingResultsTable analyses={[firstAnalysis, secondAnalysis]} />
      </section>
    </div>
  );
}

function TeamLapTimelineChart({ team }: { team: HistoricalTeam }) {
  const rawPoints = team.lapDurationsMs.map((durationMs, lapIndex) => ({
    x: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
    y: durationMs / 1_000,
  }));
  const rollingMedianPoints = rawPoints.map((point, pointIndex) => ({
    x: point.x,
    y: medianValue(rawPoints.slice(Math.max(0, pointIndex - 19), pointIndex + 1).map((candidate) => candidate.y)),
  }));
  return (
    <ChartPanel configuration={{
      type: 'scatter',
      data: {
        datasets: [
          {
            label: `Rondes team ${team.teamId}`,
            data: rawPoints,
            backgroundColor: withOpacity(teamColor(team.teamId), 0.35),
            borderColor: 'transparent',
            pointRadius: 2,
          },
          xySeries('Lopende mediaan (20)', rollingMedianPoints, '#172033', 2),
        ],
      },
      options: xyChartOptions('Rondetijd', formatSeconds),
    }} />
  );
}

function DurationDistributionChart({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const firstSeconds = firstTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000);
  const secondSeconds = secondTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000);
  const minimum = Math.floor(Math.min(...firstSeconds, ...secondSeconds) / 2) * 2;
  const maximum = Math.ceil(Math.min(180, Math.max(...firstSeconds, ...secondSeconds)) / 2) * 2;
  const labels = Array.from({ length: Math.max(1, (maximum - minimum) / 2 + 1) }, (_, index) => minimum + index * 2);
  const frequency = (durations: number[]) => labels.map((lowerBound) =>
    durations.filter((duration) => duration >= lowerBound && duration < lowerBound + 2).length
  );
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        labels,
        datasets: [
          lineSeries(`Team ${firstTeam.teamId}`, frequency(firstSeconds), teamColor(firstTeam.teamId)),
          lineSeries(`Team ${secondTeam.teamId}`, frequency(secondSeconds), teamColor(secondTeam.teamId)),
        ],
      },
      options: categoryChartOptions('Rondetijd (s)', 'Aantal rondes'),
    }} />
  );
}

function DistributionRow({
  team,
  summary,
}: {
  team: HistoricalTeam;
  summary: ReturnType<typeof summarizeHistoricalWindow>;
}) {
  return (
    <tr>
      <td><span className="tactics-team-key"><i style={{ background: teamColor(team.teamId) }} />Team {team.teamId}</span></td>
      <td>{summary.laps}</td>
      <td>{formatNullableSeconds(summary.medianSeconds)}</td>
      <td>{summary.interquartileRangeSeconds == null ? '—' : `${summary.interquartileRangeSeconds.toFixed(1)}s`}</td>
      <td>{summary.outlierCount}</td>
    </tr>
  );
}

function WindowFrequencyChart({
  firstTeam,
  secondTeam,
  startHour,
  endHour,
}: {
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
  startHour: number;
  endHour: number;
}) {
  const durations = (team: HistoricalTeam) => team.lapDurationsMs
    .map((durationMs, lapIndex) => ({
      durationSeconds: durationMs / 1_000,
      raceHour: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
    }))
    .filter((lap) => lap.raceHour >= startHour && lap.raceHour < endHour)
    .map((lap) => lap.durationSeconds);
  const firstDurations = durations(firstTeam);
  const secondDurations = durations(secondTeam);
  const combinedDurations = [...firstDurations, ...secondDurations];
  const minimum = Math.floor(Math.max(0, percentileValue(combinedDurations, 0.02) - 4) / 2) * 2;
  const maximum = Math.ceil((percentileValue(combinedDurations, 0.98) + 4) / 2) * 2;
  const labels = Array.from({ length: Math.max(1, (maximum - minimum) / 2 + 1) }, (_, index) => minimum + index * 2);
  const frequency = (lapDurations: number[]) => labels.map((lowerBound) =>
    lapDurations.filter((duration) => duration >= lowerBound && duration < lowerBound + 2).length
  );
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        labels,
        datasets: [
          lineSeries(`Team ${firstTeam.teamId}`, frequency(firstDurations), teamColor(firstTeam.teamId)),
          lineSeries(`Team ${secondTeam.teamId}`, frequency(secondDurations), teamColor(secondTeam.teamId)),
        ],
      },
      options: categoryChartOptions('Rondetijd (s)', 'Aantal rondes'),
    }} />
  );
}

function PaceComparisonChart({ points, firstTeam, secondTeam }: { points: PacePoint[]; firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  return <ChartPanel configuration={xyLineConfiguration(points, firstTeam, secondTeam, 'Mediaan rondetijd', formatSeconds)} />;
}

function HalfHourDifferenceChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildHalfHourPaceDifferences>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel configuration={{
      type: 'bar',
      data: {
        labels: points.map((point) => `${point.raceHour.toFixed(2)}u`),
        datasets: [{
          label: `Team ${firstTeam.teamId} min team ${secondTeam.teamId}`,
          data: points.map((point) => point.differenceSeconds),
          backgroundColor: points.map((point) => point.differenceSeconds == null
            ? '#cbd5e1'
            : point.differenceSeconds > 0 ? teamColor(secondTeam.teamId) : teamColor(firstTeam.teamId)),
          borderRadius: 3,
        }],
      },
      options: categoryChartOptions('Halve race-uren', 'Verschil rondetijd', (value) => `${signedNumber(value, 0)}s`),
    }} />
  );
}

function ConsistencyChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildHourlyConsistency>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Mediaan team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstSeconds })), teamColor(firstTeam.teamId), 3),
          xySeries(`P10 team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstP10Seconds })), teamColor(firstTeam.teamId), 1, [6, 5]),
          xySeries(`P90 team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstP90Seconds })), teamColor(firstTeam.teamId), 1, [6, 5]),
          xySeries(`Mediaan team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondSeconds })), teamColor(secondTeam.teamId), 3),
          xySeries(`P10 team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondP10Seconds })), teamColor(secondTeam.teamId), 1, [6, 5]),
          xySeries(`P90 team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondP90Seconds })), teamColor(secondTeam.teamId), 1, [6, 5]),
        ],
      },
      options: xyChartOptions('Seconden', formatSeconds),
    }} />
  );
}

function StandardDeviationChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildHourlyConsistency>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Spreiding team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstStandardDeviationSeconds })), teamColor(firstTeam.teamId), 2),
          xySeries(`Spreiding team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondStandardDeviationSeconds })), teamColor(secondTeam.teamId), 2),
        ],
      },
      options: xyChartOptions('Standaardafwijking (s)', (value) => `${Number(value).toFixed(1)}s`),
    }} />
  );
}

function TimeGapChart({ points, firstTeam, secondTeam }: { points: ReturnType<typeof buildTimeGapCurve>; firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Tijdskloof team ${firstTeam.teamId} op team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.gapSeconds })), '#172033', 3),
          xySeries('Gelijke stand', [{ x: 0, y: 0 }, { x: 24, y: 0 }], '#94a3b8', 1, [6, 5]),
        ],
      },
      options: xyChartOptions('Tijdsverschil', formatSignedSeconds),
    }} />
  );
}

function SameLapGapChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildSameLapIndexGap>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Team ${firstTeam.teamId} tegenover team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.gapSeconds })), '#172033', 3),
          xySeries('Gelijke ronde-index', [{ x: 0, y: 0 }, { x: 24, y: 0 }], '#94a3b8', 1, [6, 5]),
        ],
      },
      options: xyChartOptions('Tijdsverschil', formatSignedSeconds),
    }} />
  );
}

function HourlyGainChart({ points, firstTeam, secondTeam }: { points: ReturnType<typeof buildHourlyLapGains>; firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  return (
    <ChartPanel configuration={{
      type: 'bar',
      data: {
        labels: points.map((point) => `${point.raceHour}u`),
        datasets: [{
          label: `Team ${secondTeam.teamId} min team ${firstTeam.teamId}`,
          data: points.map((point) => point.lapDifference),
          backgroundColor: points.map((point) => point.lapDifference > 0
            ? teamColor(secondTeam.teamId)
            : point.lapDifference < 0 ? teamColor(firstTeam.teamId) : '#cbd5e1'),
          borderRadius: 4,
        }],
      },
      options: categoryChartOptions('Race-uur', 'Verschil in rondes'),
    }} />
  );
}

function CumulativeRaceChart({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const teamPoints = (team: HistoricalTeam) => [
    { x: 0, y: 0 },
    ...team.cumulativeLapTimesMs.map((timestampMs, lapIndex) => ({ x: timestampMs / 3_600_000, y: lapIndex + 1 })),
  ];
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Team ${firstTeam.teamId}`, teamPoints(firstTeam), teamColor(firstTeam.teamId), 3),
          xySeries(`Team ${secondTeam.teamId}`, teamPoints(secondTeam), teamColor(secondTeam.teamId), 3),
        ],
      },
      options: xyChartOptions('Cumulatieve rondes', (value) => String(Math.round(Number(value))), true),
    }} />
  );
}

function RaceLeadChart({
  points,
  firstTeam,
  secondTeam,
  lapLengthMeters,
}: {
  points: ReturnType<typeof buildRaceLeadCurve>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
  lapLengthMeters: number;
}) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(
            `Voorsprong team ${firstTeam.teamId} in rondes`,
            points.map((point) => ({ x: point.raceHour, y: point.lapDifference })),
            '#172033',
            3
          ),
          xySeries('Gelijke stand', [{ x: 0, y: 0 }, { x: 24, y: 0 }], '#94a3b8', 1, [6, 5]),
        ],
      },
      options: xyChartOptions(
        `Rondeverschil · ${lapLengthMeters} m per ronde`,
        (value) => `${signedNumber(Number(value), 0)} (${signedNumber(Number(value) * lapLengthMeters, 0)} m)`
      ),
    }} />
  );
}

function DiagnosticTimelineChart({
  firstTeam,
  secondTeam,
  firstSlowLaps,
  secondSlowLaps,
  firstChanges,
  secondChanges,
}: {
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
  firstSlowLaps: ReturnType<typeof findSlowLaps>;
  secondSlowLaps: ReturnType<typeof findSlowLaps>;
  firstChanges: ReturnType<typeof findPaceChanges>;
  secondChanges: ReturnType<typeof findPaceChanges>;
}) {
  const diagnosticSeries = (
    label: string,
    laps: Array<{ raceHour: number; durationSeconds: number }>,
    color: string,
    markerStyle: 'circle' | 'triangle'
  ) => ({
    label,
    data: laps.map((lap) => ({ x: lap.raceHour, y: lap.durationSeconds })),
    showLine: false,
    borderColor: color,
    backgroundColor: color,
    pointRadius: 5,
    pointStyle: markerStyle,
  });
  return (
    <ChartPanel configuration={{
      type: 'scatter',
      data: {
        datasets: [
          diagnosticSeries(`Trage rondes team ${firstTeam.teamId}`, firstSlowLaps, teamColor(firstTeam.teamId), 'circle'),
          diagnosticSeries(`Temposprongen team ${firstTeam.teamId}`, firstChanges, teamColor(firstTeam.teamId), 'triangle'),
          diagnosticSeries(`Trage rondes team ${secondTeam.teamId}`, secondSlowLaps, teamColor(secondTeam.teamId), 'circle'),
          diagnosticSeries(`Temposprongen team ${secondTeam.teamId}`, secondChanges, teamColor(secondTeam.teamId), 'triangle'),
        ],
      },
      options: xyChartOptions('Rondetijd', formatSeconds),
    }} />
  );
}

function BreakEvenChart({ points, targetLaps, teamId }: { points: ReturnType<typeof buildBreakEvenSensitivity>; targetLaps: number; teamId: number }) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Projectie team ${teamId}`, points.map((point) => ({ x: point.improvementSeconds, y: point.projectedLaps })), teamColor(teamId), 3),
          xySeries('Te kloppen resultaat', [{ x: 0, y: targetLaps }, { x: points[points.length - 1]?.improvementSeconds ?? 15, y: targetLaps }], '#172033', 2, [6, 5]),
        ],
      },
      options: xyChartOptions('Totaal rondes', (value) => String(Math.round(Number(value))), false, 'Verbetering per ronde (s)'),
    }} />
  );
}

function DraftingProximityChart({ firstAnalysis, secondAnalysis }: { firstAnalysis: DraftingTeamAnalysis; secondAnalysis: DraftingTeamAnalysis }) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        labels: firstAnalysis.proximityBins.map((bin) => bin.label),
        datasets: [
          lineSeries(`Team ${firstAnalysis.teamId}`, firstAnalysis.proximityBins.map((bin) => bin.medianSeconds), teamColor(firstAnalysis.teamId)),
          lineSeries(`Team ${secondAnalysis.teamId}`, secondAnalysis.proximityBins.map((bin) => bin.medianSeconds), teamColor(secondAnalysis.teamId)),
        ],
      },
      options: categoryChartOptions('Afstand tot dichtstbijzijnde passage', 'Mediaan rondetijd', formatSeconds),
    }} />
  );
}

function DraftingScatterChart({ firstAnalysis, secondAnalysis }: { firstAnalysis: DraftingTeamAnalysis; secondAnalysis: DraftingTeamAnalysis }) {
  const scatterSeries = (analysis: DraftingTeamAnalysis) => ({
    label: `Team ${analysis.teamId}`,
    data: analysis.signedGapSeconds.map((signedGap, lapIndex) => ({ x: signedGap, y: analysis.lapDurationsSeconds[lapIndex] })),
    borderColor: teamColor(analysis.teamId),
    backgroundColor: `${teamColor(analysis.teamId)}55`,
    pointRadius: 2,
    pointHoverRadius: 5,
  });
  const trendSeries = (analysis: DraftingTeamAnalysis) => {
    const visiblePoints = analysis.signedGapSeconds
      .map((signedGap, lapIndex) => ({ x: signedGap, y: analysis.lapDurationsSeconds[lapIndex] }))
      .filter((point) => Number.isFinite(point.x) && Math.abs(point.x) <= 35);
    return xySeries(
      `Trend team ${analysis.teamId}`,
      linearTrend(visiblePoints, -35, 35),
      teamColor(analysis.teamId),
      3
    );
  };
  return (
    <ChartPanel configuration={{
      type: 'scatter',
      data: {
        datasets: [
          scatterSeries(firstAnalysis),
          scatterSeries(secondAnalysis),
          trendSeries(firstAnalysis),
          trendSeries(secondAnalysis),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: chartPlugins(formatSeconds),
        scales: {
          x: { type: 'linear', min: -35, max: 35, title: axisTitle('Positie: voor (-) of achter (+), seconden'), ticks: { color: workspaceChartPalette.muted }, grid: { color: workspaceChartPalette.grid } },
          y: { title: axisTitle('Rondetijd'), ticks: { color: workspaceChartPalette.muted, callback: (value) => formatSeconds(Number(value)) }, grid: { color: workspaceChartPalette.grid } },
        },
      },
    }} />
  );
}

function DraftingResultsTable({ analyses }: { analyses: DraftingTeamAnalysis[] }) {
  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead>
          <tr><th>Team</th><th>Vergelijking</th><th>n eerste</th><th>Mediaan eerste</th><th>n tweede</th><th>Mediaan tweede</th><th>Effect</th><th>p</th><th>Sign.</th></tr>
        </thead>
        <tbody>
          {analyses.flatMap((analysis) => analysis.comparisons.map((comparison) => (
            <tr key={`${analysis.teamId}-${comparison.label}`}>
              <td><strong>Team {analysis.teamId}</strong></td>
              <td>{comparison.label}</td>
              <td>{comparison.firstCount}</td>
              <td>{formatNullableSeconds(comparison.firstMedianSeconds)}</td>
              <td>{comparison.secondCount}</td>
              <td>{formatNullableSeconds(comparison.secondMedianSeconds)}</td>
              <td>{comparison.effectSeconds == null ? 'Geen data' : `${signedNumber(comparison.effectSeconds, 2)}s`}</td>
              <td>{comparison.pValue == null ? 'Geen data' : comparison.pValue.toFixed(4)}</td>
              <td><span className={`tactics-significance ${comparison.pValue != null && comparison.pValue < 0.05 ? 'is-significant' : ''}`}>{significanceLabel(comparison.pValue)}</span></td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  );
}

function DiagnosticTable({ title, laps }: { title: string; laps: ReturnType<typeof findSlowLaps> }) {
  return (
    <div>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="analysis-table">
          <thead><tr><th>Ronde</th><th>Race-uur</th><th>Tijd</th></tr></thead>
          <tbody>{laps.map((lap) => <tr key={lap.lapNumber}><td>{lap.lapNumber}</td><td>{lap.raceHour.toFixed(2)}u</td><td>{formatSeconds(lap.durationSeconds)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function PaceChangeTable({ title, changes }: { title: string; changes: ReturnType<typeof findPaceChanges> }) {
  return (
    <div>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="analysis-table">
          <thead><tr><th>Ronde</th><th>Race-uur</th><th>Verschil</th></tr></thead>
          <tbody>{changes.map((change) => <tr key={change.lapNumber}><td>{change.lapNumber}</td><td>{change.raceHour.toFixed(2)}u</td><td>{signedNumber(change.differenceSeconds, 1)}s</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function NightPenaltyStat({
  team,
  penalty,
}: {
  team: HistoricalTeam;
  penalty: ReturnType<typeof calculateNightPenalty>;
}) {
  return (
    <DeepStat
      label={`Nachtpenalty team ${team.teamId}`}
      value={penalty.penaltySeconds == null ? 'Geen data' : `${signedNumber(penalty.penaltySeconds, 1)}s`}
      detail={`Dag ${formatNullableSeconds(penalty.dayMedianSeconds)}, nacht ${formatNullableSeconds(penalty.nightMedianSeconds)}`}
    />
  );
}

function NumberControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <div className="tactics-number-control">
        <input className="input" type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(clamp(Number(event.target.value) || min, min, max))} />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}

function DeepStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="stat-panel tactics-stat"><span className="muted-label">{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function SectionHeader({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return <div className="analysis-section-header"><span className="page-kicker">{kicker}</span><h2>{title}</h2><p>{text}</p></div>;
}

function ChartPanel({ configuration }: { configuration: ChartConfiguration }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    if (!canvasRef.current) return undefined;
    const chart = new Chart(canvasRef.current, configuration);
    return () => chart.destroy();
  }, [configuration]);
  return <div className="analysis-chart-card tactics-chart-card"><canvas ref={canvasRef} /></div>;
}

function xyLineConfiguration(
  points: PacePoint[],
  firstTeam: HistoricalTeam,
  secondTeam: HistoricalTeam,
  yAxisTitle: string,
  formatter: (value: number) => string
): ChartConfiguration<'line'> {
  return {
    type: 'line',
    data: {
      datasets: [
        xySeries(`Team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstSeconds })), teamColor(firstTeam.teamId), 3),
        xySeries(`Team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondSeconds })), teamColor(secondTeam.teamId), 3),
      ],
    },
    options: xyChartOptions(yAxisTitle, formatter),
  };
}

function xySeries(label: string, data: Array<{ x: number; y: number | null }>, color: string, borderWidth = 2, borderDash?: number[]) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth, borderDash, pointRadius: 0, pointHoverRadius: 5, tension: 0.2, spanGaps: false };
}

function lineSeries(label: string, data: Array<number | null>, color: string) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth: 3, pointRadius: 2, pointHoverRadius: 5, tension: 0.25, spanGaps: false };
}

function xyChartOptions(
  yAxisTitle: string,
  formatter: (value: number) => string,
  beginAtZero = false,
  xAxisTitle = 'Uren sinds de start'
): ChartConfiguration<'line'>['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: chartPlugins(formatter),
    scales: {
      x: { type: 'linear', min: 0, title: axisTitle(xAxisTitle), ticks: { color: workspaceChartPalette.muted }, grid: { color: workspaceChartPalette.grid } },
      y: { beginAtZero, title: axisTitle(yAxisTitle), ticks: { color: workspaceChartPalette.muted, callback: (value) => formatter(Number(value)) }, grid: { color: workspaceChartPalette.grid } },
    },
  };
}

function categoryChartOptions(
  xAxisTitle: string,
  yAxisTitle: string,
  formatter: (value: number) => string = (value) => String(value)
): ChartConfiguration['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: chartPlugins(formatter),
    scales: {
      x: { title: axisTitle(xAxisTitle), ticks: { color: workspaceChartPalette.muted, maxTicksLimit: 18 }, grid: { color: workspaceChartPalette.grid } },
      y: { beginAtZero: true, title: axisTitle(yAxisTitle), ticks: { color: workspaceChartPalette.muted, callback: (value) => formatter(Number(value)) }, grid: { color: workspaceChartPalette.grid } },
    },
  };
}

function chartPlugins(formatter: (value: number) => string) {
  return {
    legend: { position: 'top' as const, labels: { boxWidth: 14, color: workspaceChartPalette.text, font: { weight: 'bold' as const } } },
    tooltip: { callbacks: { label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => `${context.dataset.label}: ${context.parsed.y == null ? 'geen data' : formatter(context.parsed.y)}` } },
  };
}

function axisTitle(text: string) {
  return { display: true, text, color: workspaceChartPalette.muted, font: { weight: 'bold' as const } };
}

function teamColor(teamId: number, fallbackIndex = 0): string {
  if (teamId === 1) return '#0072B2';
  if (teamId === 4) return '#F0B400';
  const alternatives = ['#009E73', '#D55E00', '#CC79A7', '#7F3FBF', '#8B4513', '#64748b'];
  return alternatives[fallbackIndex % alternatives.length];
}

function formatSeconds(seconds: number): string {
  return formatDurationMs(seconds * 1_000);
}

function formatNullableSeconds(seconds: number | null): string {
  return seconds == null ? 'Geen data' : formatSeconds(seconds);
}

function formatSignedSeconds(seconds: number): string {
  return `${signedNumber(seconds, 0)}s`;
}

function signedNumber(value: number, fractionDigits = 0): string {
  const roundedValue = Number(value.toFixed(fractionDigits));
  return `${roundedValue > 0 ? '+' : ''}${roundedValue.toLocaleString('nl-BE', { maximumFractionDigits: fractionDigits })}`;
}

function significanceLabel(pValue: number | null): string {
  if (pValue == null) return 'n.v.t.';
  if (pValue < 0.001) return '***';
  if (pValue < 0.01) return '**';
  if (pValue < 0.05) return '*';
  return 'n.s.';
}

function percentage(part: number, total: number): string {
  return total ? `${(part / total * 100).toFixed(1)}%` : '0%';
}

function medianValue(values: number[]): number | null {
  if (!values.length) return null;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2
    ? sortedValues[middleIndex]
    : (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}

function percentileValue(values: number[], probability: number): number {
  if (!values.length) return 60;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const fraction = position - lowerIndex;
  return sortedValues[lowerIndex] + (sortedValues[Math.min(lowerIndex + 1, sortedValues.length - 1)] - sortedValues[lowerIndex]) * fraction;
}

function linearTrend(
  points: Array<{ x: number; y: number }>,
  minimumX: number,
  maximumX: number
): Array<{ x: number; y: number }> {
  if (points.length < 2) return [];
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope = denominator === 0
    ? 0
    : points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
  const intercept = meanY - slope * meanX;
  return [
    { x: minimumX, y: intercept + slope * minimumX },
    { x: maximumX, y: intercept + slope * maximumX },
  ];
}

function withOpacity(hexColor: string, opacity: number): string {
  const alpha = Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, '0');
  return `${hexColor}${alpha}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
