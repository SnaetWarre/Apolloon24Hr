import React from 'react';
import { useChartTheme } from '../../lib/chartPalette';
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
} from '../../lib/tacticsDeepDive';
import {
  BreakEvenChart,
  ConsistencyChart,
  CumulativeRaceChart,
  DeepStat,
  DiagnosticTable,
  DiagnosticTimelineChart,
  DistributionRow,
  DraftingProximityChart,
  DraftingResultsTable,
  DraftingScatterChart,
  DurationDistributionChart,
  HalfHourDifferenceChart,
  HourlyGainChart,
  NightPenaltyStat,
  NumberControl,
  PaceChangeTable,
  PaceComparisonChart,
  RaceLeadChart,
  SameLapGapChart,
  SectionHeader,
  StandardDeviationChart,
  TeamLapTimelineChart,
  TimeGapChart,
  WindowFrequencyChart,
  formatSeconds,
  formatSignedSeconds,
  percentage,
  signedNumber,
  teamColor,
} from './deepdiveCharts';

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
  // Chart configurations are built during render; re-render them with the new theme colours.
  useChartTheme();

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
  const summaries = summarizeHistoricalTeams(historicalRace);
  const [detailTeamId, setDetailTeamId] = React.useState(firstTeam.teamId);
  const firstSummary = summaries.find((summary) => summary.teamId === firstTeam.teamId)!;
  const secondSummary = summaries.find((summary) => summary.teamId === secondTeam.teamId)!;
  const detailTeam = historicalRace.teams.find((team) => team.teamId === detailTeamId) ?? firstTeam;

  return (
    <div className="tactics-section-stack">
      <section className="stats-grid stats-grid--analysis tactics-live-stats" aria-label="Historische kerncijfers">
        <DeepStat
          label={firstTeam.teamName}
          value={`${firstSummary.laps} rondes`}
          detail={`Mediaan ${formatSeconds(firstSummary.medianSeconds)}`}
        />
        <DeepStat
          label={secondTeam.teamName}
          value={`${secondSummary.laps} rondes`}
          detail={`Mediaan ${formatSeconds(secondSummary.medianSeconds)}`}
        />
        <DeepStat
          label="Verschil na 24u"
          value={signedNumber(firstSummary.laps - secondSummary.laps)}
          detail={`${firstTeam.teamName} tegenover ${secondTeam.teamName}`}
        />
        <DeepStat
          label="Meest consistent"
          value={
            firstSummary.standardDeviationSeconds <= secondSummary.standardDeviationSeconds
              ? firstTeam.teamName
              : secondTeam.teamName
          }
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
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>Rondes</th>
                <th>Mediaan</th>
                <th>P10-P90</th>
                <th>Spreiding</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary, index) => (
                <tr
                  key={summary.teamId}
                  className={
                    summary.teamId === firstTeam.teamId || summary.teamId === secondTeam.teamId ? 'is-selected' : ''
                  }
                >
                  <td>{index + 1}</td>
                  <td>
                    <span className="tactics-team-key">
                      <i style={{ background: teamColor(summary.teamId, index) }} />
                      {summary.teamName}
                    </span>
                  </td>
                  <td>
                    <strong>{summary.laps}</strong>
                  </td>
                  <td>{formatSeconds(summary.medianSeconds)}</td>
                  <td>
                    {formatSeconds(summary.p10Seconds)} tot {formatSeconds(summary.p90Seconds)}
                  </td>
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
            title={`Alle passages van ${detailTeam.teamName}`}
            text="Elke stip is een geregistreerde ronde. De donkere lijn is de lopende mediaan over twintig rondes, zoals in Kobe zijn oorspronkelijke analyse."
          />
          <label className="tactics-compact-select">
            <span>Team in detail</span>
            <select
              className="input"
              value={detailTeam.teamId}
              onChange={(event) => setDetailTeamId(Number(event.target.value))}
            >
              {historicalRace.teams.map((team) => (
                <option key={team.teamId} value={team.teamId}>
                  {team.teamName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <TeamLapTimelineChart team={detailTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Verdeling"
          title={`Rondetijdfrequentie van ${firstTeam.teamName} en ${secondTeam.teamName}`}
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
  const quarterPaces = buildQuarterHourPaces(firstTeam, secondTeam, startHour, endHour);
  const smoothedPaces = smoothPacePoints(quarterPaces);
  const consistency = buildHourlyConsistency(firstTeam, secondTeam);
  const halfHourDifferences = buildHalfHourPaceDifferences(firstTeam, secondTeam, startHour, endHour);
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
          <NumberControl
            label="Nacht vanaf"
            value={nightStartHour}
            min={0}
            max={nightEndHour - 1}
            onChange={setNightStartHour}
          />
          <NumberControl
            label="Nacht tot"
            value={nightEndHour}
            min={nightStartHour + 1}
            max={24}
            onChange={setNightEndHour}
          />
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
          text={`Positief betekent dat ${firstTeam.teamName} trager was; negatief betekent dat ${firstTeam.teamName} sneller was dan ${secondTeam.teamName}.`}
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
            <thead>
              <tr>
                <th>Team</th>
                <th>Rondes</th>
                <th>Mediaan</th>
                <th>IQR</th>
                <th>Uitschieters</th>
              </tr>
            </thead>
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
  const timeGap = buildTimeGapCurve(firstTeam, secondTeam);
  const hourlyGains = buildHourlyLapGains(firstTeam, secondTeam);
  const raceLead = buildRaceLeadCurve(firstTeam, secondTeam);
  const sameLapGap = buildSameLapIndexGap(firstTeam, secondTeam);
  const finalLapGap = secondTeam.cumulativeLapTimesMs.length - firstTeam.cumulativeLapTimesMs.length;
  const finalTimeGap = timeGap[timeGap.length - 1]?.gapSeconds ?? 0;

  return (
    <div className="tactics-section-stack">
      <section className="stats-grid stats-grid--analysis tactics-live-stats">
        <DeepStat
          label={`Tijdskloof ${firstTeam.teamName}`}
          value={formatSignedSeconds(finalTimeGap)}
          detail={`Positief betekent achter op ${secondTeam.teamName}`}
        />
        <DeepStat
          label="Rondeverschil"
          value={signedNumber(-finalLapGap)}
          detail={`${firstTeam.teamName} tegenover ${secondTeam.teamName}`}
        />
        <DeepStat
          label="Afstandsverschil"
          value={`${signedNumber(-finalLapGap * lapLengthMeters)} m`}
          detail={`${lapLengthMeters} meter per ronde`}
        />
        <label className="stat-panel tactics-stat tactics-stat--control">
          <span className="muted-label">Rondelengte</span>
          <input
            type="number"
            min={1}
            step={10}
            value={lapLengthMeters}
            onChange={(event) => setLapLengthMeters(Math.max(1, Number(event.target.value) || 1))}
          />
          <small>meter</small>
        </label>
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Tijdsachterstand"
          title={`Hoeveel tijd lag ${firstTeam.teamName} voor of achter?`}
          text={`Benaderde tijd om op elk moment dezelfde voortgang als ${secondTeam.teamName} te halen. Positief is achterstand.`}
        />
        <TimeGapChart points={timeGap} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Dezelfde ronde-index"
          title="Tijdsverschil bij exact dezelfde ronde"
          text={`Vergelijkt ronde 1 met ronde 1, ronde 2 met ronde 2 enzovoort. Positief betekent dat ${firstTeam.teamName} die ronde-index later bereikte.`}
        />
        <SameLapGapChart points={sameLapGap} firstTeam={firstTeam} secondTeam={secondTeam} />
      </section>

      <section className="panel">
        <SectionHeader
          kicker="Uur per uur"
          title={`Gewonnen of verloren rondes tegenover ${secondTeam.teamName}`}
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
          text={`Boven nul lag ${firstTeam.teamName} voor, onder nul ${secondTeam.teamName}. De tweede as rekent hetzelfde verschil om met ${lapLengthMeters} meter per ronde.`}
        />
        <RaceLeadChart points={raceLead} firstTeam={firstTeam} lapLengthMeters={lapLengthMeters} />
      </section>
    </div>
  );
}

function DiagnosticsSection({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const suggestedThreshold = defaultSlowLapThreshold(firstTeam, secondTeam);
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
          <NumberControl
            label="Trage ronde vanaf"
            suffix="s"
            value={slowThresholdSeconds}
            min={10}
            max={300}
            onChange={setSlowThresholdSeconds}
          />
          <NumberControl
            label="Temposprong vanaf"
            suffix="s"
            value={paceChangeThresholdSeconds}
            min={1}
            max={60}
            onChange={setPaceChangeThresholdSeconds}
          />
        </div>
      </section>

      <section className="stats-grid stats-grid--analysis tactics-live-stats">
        <DeepStat
          label={`Trage rondes ${firstTeam.teamName}`}
          value={String(firstSlowLaps.length)}
          detail={`${percentage(firstSlowLaps.length, firstTeam.lapDurationsMs.length)} boven de grens`}
        />
        <DeepStat
          label={`Trage rondes ${secondTeam.teamName}`}
          value={String(secondSlowLaps.length)}
          detail={`${percentage(secondSlowLaps.length, secondTeam.lapDurationsMs.length)} boven de grens`}
        />
        <DeepStat
          label={`Temposprongen ${firstTeam.teamName}`}
          value={String(firstChanges.length)}
          detail={`Meer dan ${paceChangeThresholdSeconds}s verschil`}
        />
        <DeepStat
          label={`Temposprongen ${secondTeam.teamName}`}
          value={String(secondChanges.length)}
          detail={`Meer dan ${paceChangeThresholdSeconds}s verschil`}
        />
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
        <DiagnosticTable title={`Grootste trage rondes ${firstTeam.teamName}`} laps={firstSlowLaps.slice(0, 10)} />
        <DiagnosticTable title={`Grootste trage rondes ${secondTeam.teamName}`} laps={secondSlowLaps.slice(0, 10)} />
        <PaceChangeTable title={`Sterkste temposprongen ${firstTeam.teamName}`} changes={firstChanges.slice(0, 10)} />
        <PaceChangeTable title={`Sterkste temposprongen ${secondTeam.teamName}`} changes={secondChanges.slice(0, 10)} />
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
            <select
              className="input"
              value={improvingTeamId}
              onChange={(event) => setImprovingTeamId(Number(event.target.value))}
            >
              <option value={firstTeam.teamId}>{firstTeam.teamName}</option>
              <option value={secondTeam.teamId}>{secondTeam.teamName}</option>
            </select>
          </label>
          <NumberControl
            label="Maximale verbetering"
            suffix="s"
            value={maximumImprovementSeconds}
            min={1}
            max={60}
            step={0.5}
            onChange={setMaximumImprovementSeconds}
          />
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
        <BreakEvenChart points={sensitivity} targetLaps={targetTeam.cumulativeLapTimesMs.length} team={improvingTeam} />
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
  const options = {
    startHour,
    endHour,
    closeSeconds,
    farSeconds,
    minimumLapSeconds,
    maximumLapSeconds,
  };
  const firstAnalysis = analyzeDrafting(firstTeam, secondTeam, options);
  const secondAnalysis = analyzeDrafting(secondTeam, firstTeam, options);

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
          <NumberControl
            label="Dichtbij tot"
            suffix="s"
            value={closeSeconds}
            min={1}
            max={farSeconds - 1}
            onChange={setCloseSeconds}
          />
          <NumberControl
            label="Ver weg vanaf"
            suffix="s"
            value={farSeconds}
            min={closeSeconds + 1}
            max={120}
            onChange={setFarSeconds}
          />
          <NumberControl
            label="Minimum ronde"
            suffix="s"
            value={minimumLapSeconds}
            min={1}
            max={maximumLapSeconds - 1}
            onChange={setMinimumLapSeconds}
          />
          <NumberControl
            label="Maximum ronde"
            suffix="s"
            value={maximumLapSeconds}
            min={minimumLapSeconds + 1}
            max={300}
            onChange={setMaximumLapSeconds}
          />
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
