import React from 'react';
import {
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type Plugin,
} from 'chart.js';
import { chartTooltipColors, useChartTheme, workspaceChartPalette } from '../../lib/chartPalette';
import { RACE_DURATION_HOURS, type HourlyLapCountPoint, type LapTimelinePoint } from '../../lib/tactics';
import { clamp, formatRaceClock, formatRaceHour, formatRaceHourWindow, nightRaceHourRanges } from './tacticsFormat';

Chart.register(LinearScale, LineController, LineElement, PointElement, Tooltip);

type TimelineView = 'gap' | 'hourly' | 'total';
type SeriesKey = 'live' | 'target' | 'own' | 'rival';
type TimeWindow = { kind: 'full' } | { kind: 'recent'; hours: number } | { kind: 'custom'; min: number; max: number };
type SeriesPoint = { x: number; y: number | null };
type SeriesData = { key: SeriesKey; points: SeriesPoint[] };
type ChartDecor = {
  nights: Array<[number, number]>;
  nowHour: number | null;
  onLayout: ((chart: Chart) => void) | null;
};

const MIN_WINDOW_HOURS = 0.25;
const DRAG_THRESHOLD_PX = 8;

const SERIES: Array<{
  key: SeriesKey;
  label: string;
  shortLabel: string;
  cssColor: string;
  color: () => string;
  borderWidth: number;
  borderDash?: number[];
}> = [
  {
    key: 'live',
    label: 'Apolloon live',
    shortLabel: 'Apolloon live',
    cssColor: 'var(--series-live)',
    color: () => workspaceChartPalette.live,
    borderWidth: 3,
  },
  {
    key: 'target',
    label: 'Doelverloop',
    shortLabel: 'het doel',
    cssColor: 'var(--series-target)',
    color: () => workspaceChartPalette.target,
    borderWidth: 2,
    borderDash: [6, 5],
  },
  {
    key: 'own',
    label: 'Apolloon vorig jaar',
    shortLabel: 'Apolloon vorig jaar',
    cssColor: 'var(--series-own)',
    color: () => workspaceChartPalette.own,
    borderWidth: 2,
  },
  {
    key: 'rival',
    label: 'VTK vorig jaar',
    shortLabel: 'VTK vorig jaar',
    cssColor: 'var(--series-rival)',
    color: () => workspaceChartPalette.rival,
    borderWidth: 2,
  },
];

const VALUE_KEYS = {
  live: 'liveLaps',
  target: 'targetLaps',
  own: 'ownHistoricalLaps',
  rival: 'rivalHistoricalLaps',
} as const satisfies Record<SeriesKey, keyof LapTimelinePoint & keyof HourlyLapCountPoint>;

const VIEWS: Array<{ id: TimelineView; label: string }> = [
  { id: 'gap', label: 'Voor of achter' },
  { id: 'hourly', label: 'Rondes per uur' },
  { id: 'total', label: 'Totaal' },
];

const WINDOW_PRESETS: Array<{ id: string; label: string; window: TimeWindow }> = [
  { id: 'full', label: 'Hele race', window: { kind: 'full' } },
  { id: 'recent-3', label: 'Laatste 3 u', window: { kind: 'recent', hours: 3 } },
  { id: 'recent-1', label: 'Laatste uur', window: { kind: 'recent', hours: 1 } },
];

/**
 * Live laps against the target and last year's teams. The default view subtracts a baseline,
 * so a lead or deficit of a few laps fills the chart instead of hiding in a 1100-lap climb.
 * Drag across the plot or the strip below it to zoom into a stretch of the race.
 */
export function RaceTimelineChart({
  timeline,
  hourly,
  elapsedHours,
  raceStartedAt,
}: {
  timeline: LapTimelinePoint[];
  hourly: HourlyLapCountPoint[];
  elapsedHours: number;
  raceStartedAt: number;
}) {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartRef = React.useRef<Chart<'line'> | null>(null);
  const decorRef = React.useRef<ChartDecor>({ nights: [], nowHour: null, onLayout: null });
  const dragStartRef = React.useRef<number | null>(null);
  const chartTheme = useChartTheme();
  const [view, setView] = React.useState<TimelineView>('gap');
  const [baseline, setBaseline] = React.useState<SeriesKey>('target');
  const [hiddenSeries, setHiddenSeries] = React.useState<ReadonlySet<SeriesKey>>(() => new Set());
  const [timeWindow, setTimeWindow] = React.useState<TimeWindow>({ kind: 'full' });
  const [selection, setSelection] = React.useState<{ from: number; to: number } | null>(null);

  const hasOwnHistory = timeline[0]?.ownHistoricalLaps != null;
  const hasRivalHistory = timeline[0]?.rivalHistoricalLaps != null;
  const activeBaseline =
    (baseline === 'own' && !hasOwnHistory) || (baseline === 'rival' && !hasRivalHistory) ? 'target' : baseline;
  const seriesData = React.useMemo(
    () => buildSeriesData(view, activeBaseline, timeline, hourly, hasOwnHistory, hasRivalHistory),
    [activeBaseline, hasOwnHistory, hasRivalHistory, hourly, timeline, view]
  );
  const [windowMin, windowMax] = resolveTimeWindow(timeWindow, elapsedHours);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const decor = decorRef.current;
    decor.onLayout = (chart) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      // The strip under the plot lines up with the plot area, so both share one time axis.
      wrapper.style.setProperty('--plot-left', `${chart.chartArea.left}px`);
      wrapper.style.setProperty('--plot-right', `${chart.width - chart.chartArea.right}px`);
      wrapper.style.setProperty('--plot-top', `${chart.chartArea.top}px`);
      wrapper.style.setProperty('--plot-height', `${chart.chartArea.bottom - chart.chartArea.top}px`);
    };
    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      plugins: [raceDecorPlugin(decor)],
    });
    chartRef.current = chart;
    return () => {
      decor.onLayout = null;
      chart.destroy();
      chartRef.current = null;
    };
  }, [chartTheme]);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    decorRef.current.nights = nightRaceHourRanges(raceStartedAt);
    decorRef.current.nowHour = elapsedHours < RACE_DURATION_HOURS ? elapsedHours : null;
    chart.data.datasets = seriesData.map(({ key, points }) => {
      const series = SERIES.find((candidate) => candidate.key === key)!;
      const color = series.color();
      return {
        label: series.label,
        data: points,
        hidden: hiddenSeries.has(key),
        borderColor: color,
        backgroundColor: color,
        borderWidth: series.borderWidth,
        borderDash: series.borderDash,
        pointRadius: view === 'hourly' ? 3.5 : 0,
        pointHoverRadius: 5,
        pointBorderColor: workspaceChartPalette.surface,
        pointBorderWidth: view === 'hourly' ? 1.5 : 0,
        tension: 0,
        spanGaps: false,
      };
    });
    chart.options = timelineChartOptions(view, activeBaseline, windowMin, windowMax, raceStartedAt);
    chart.update('none');
  }, [activeBaseline, chartTheme, elapsedHours, hiddenSeries, raceStartedAt, seriesData, view, windowMax, windowMin]);

  function plotX(event: React.PointerEvent<HTMLDivElement>) {
    const chart = chartRef.current;
    if (!chart) return null;
    const x = event.clientX - chart.canvas.getBoundingClientRect().left;
    return { chart, x: clamp(x, chart.chartArea.left, chart.chartArea.right), inside: isInsidePlot(chart, x) };
  }

  function handlePlotPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const position = plotX(event);
    if (!position?.inside || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = position.x;
    setSelection({ from: position.x, to: position.x });
  }

  function handlePlotPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const dragStart = dragStartRef.current;
    const position = plotX(event);
    if (dragStart == null || !position) return;
    setSelection({ from: dragStart, to: position.x });
  }

  function handlePlotPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const dragStart = dragStartRef.current;
    const position = plotX(event);
    dragStartRef.current = null;
    setSelection(null);
    if (dragStart == null || !position || Math.abs(position.x - dragStart) < DRAG_THRESHOLD_PX) return;
    const xScale = position.chart.scales.x;
    setTimeWindow(
      customTimeWindow(
        xScale.getValueForPixel(Math.min(dragStart, position.x)) ?? windowMin,
        xScale.getValueForPixel(Math.max(dragStart, position.x)) ?? windowMax
      )
    );
  }

  function cancelPlotDrag() {
    dragStartRef.current = null;
    setSelection(null);
  }

  function toggleSeries(key: SeriesKey) {
    const nextHidden = new Set(hiddenSeries);
    if (nextHidden.has(key)) nextHidden.delete(key);
    else nextHidden.add(key);
    setHiddenSeries(nextHidden);
  }

  const availableSeries = SERIES.filter(
    (series) => (series.key !== 'own' || hasOwnHistory) && (series.key !== 'rival' || hasRivalHistory)
  );
  const activePresetId =
    timeWindow.kind === 'full' ? 'full' : timeWindow.kind === 'recent' ? `recent-${timeWindow.hours}` : null;
  const baselineSeries = availableSeries.find((series) => series.key === activeBaseline)!;
  const nights = nightRaceHourRanges(raceStartedAt);
  const sparklines = buildSparklines(seriesData, hiddenSeries);

  return (
    <div ref={wrapperRef} className="race-timeline">
      <div className="race-timeline-toolbar">
        <div className="segmented-control" role="group" aria-label="Weergave">
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={view === option.id ? 'is-active' : ''}
              aria-pressed={view === option.id}
              onClick={() => setView(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {view === 'gap' && (
          <label className="race-timeline-baseline">
            <span>Nullijn</span>
            <select
              className="input"
              value={activeBaseline}
              onChange={(event) => setBaseline(event.target.value as SeriesKey)}
            >
              {availableSeries
                .filter((series) => series.key !== 'live')
                .map((series) => (
                  <option key={series.key} value={series.key}>
                    {series.label}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className="segmented-control race-timeline-presets" role="group" aria-label="Tijdvenster">
          {WINDOW_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={activePresetId === preset.id ? 'is-active' : ''}
              aria-pressed={activePresetId === preset.id}
              onClick={() => setTimeWindow(preset.window)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="race-timeline-legend" role="group" aria-label="Lijnen tonen of verbergen">
        {availableSeries.map((series) => (
          <button
            key={series.key}
            type="button"
            className="race-timeline-legend-item"
            aria-pressed={!hiddenSeries.has(series.key)}
            onClick={() => toggleSeries(series.key)}
          >
            <span
              className={`race-timeline-swatch${series.borderDash ? ' race-timeline-swatch--dashed' : ''}`}
              style={{ '--swatch': series.cssColor } as React.CSSProperties}
              aria-hidden
            />
            {series.label}
            {view === 'gap' && series.key === activeBaseline && <em>nullijn</em>}
          </button>
        ))}
      </div>

      <div
        className="analysis-chart-card tactics-chart-card race-timeline-plot"
        onPointerDown={handlePlotPointerDown}
        onPointerMove={handlePlotPointerMove}
        onPointerUp={handlePlotPointerUp}
        onPointerCancel={cancelPlotDrag}
        onDoubleClick={() => setTimeWindow({ kind: 'full' })}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={
            view === 'gap'
              ? `Rondes voor of achter op ${baselineSeries.shortLabel}, van ${formatRaceHour(windowMin)} tot ${formatRaceHour(windowMax)}`
              : `${view === 'hourly' ? 'Rondes per race-uur' : 'Cumulatieve rondes'}, van ${formatRaceHour(windowMin)} tot ${formatRaceHour(windowMax)}`
          }
        />
        {selection && (
          <div
            className="race-timeline-selection"
            style={{ left: Math.min(selection.from, selection.to), width: Math.abs(selection.to - selection.from) }}
            aria-hidden
          />
        )}
      </div>

      <RaceWindowBrush
        windowMin={windowMin}
        windowMax={windowMax}
        nights={nights}
        nowHour={elapsedHours < RACE_DURATION_HOURS ? elapsedHours : null}
        sparklines={sparklines}
        raceStartedAt={raceStartedAt}
        onChange={(min, max) => setTimeWindow(customTimeWindow(min, max))}
      />
    </div>
  );
}

function RaceWindowBrush({
  windowMin,
  windowMax,
  nights,
  nowHour,
  sparklines,
  raceStartedAt,
  onChange,
}: {
  windowMin: number;
  windowMax: number;
  nights: Array<[number, number]>;
  nowHour: number | null;
  sparklines: Array<{ key: SeriesKey; color: string; points: string }>;
  raceStartedAt: number;
  onChange: (min: number, max: number) => void;
}) {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{
    mode: 'move' | 'start' | 'end' | 'new';
    originHour: number;
    min: number;
    max: number;
    moved: boolean;
  } | null>(null);
  const span = windowMax - windowMin;
  const isZoomed = windowMin > 0 || windowMax < RACE_DURATION_HOURS;

  function hourAt(clientX: number) {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return clamp(((clientX - rect.left) / rect.width) * RACE_DURATION_HOURS, 0, RACE_DURATION_HOURS);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target instanceof HTMLElement ? event.target.dataset.brush : undefined;
    const mode = target === 'move' || target === 'start' || target === 'end' ? target : 'new';
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode, originHour: hourAt(event.clientX), min: windowMin, max: windowMax, moved: false };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const hour = hourAt(event.clientX);
    const delta = hour - drag.originHour;
    if (drag.mode === 'move') {
      const nextMin = clamp(drag.min + delta, 0, RACE_DURATION_HOURS - (drag.max - drag.min));
      onChange(nextMin, nextMin + (drag.max - drag.min));
    } else if (drag.mode === 'start') {
      onChange(clamp(hour, 0, drag.max - MIN_WINDOW_HOURS), drag.max);
    } else if (drag.mode === 'end') {
      onChange(drag.min, clamp(hour, drag.min + MIN_WINDOW_HOURS, RACE_DURATION_HOURS));
    } else if (Math.abs(delta) >= MIN_WINDOW_HOURS) {
      onChange(Math.min(drag.originHour, hour), Math.max(drag.originHour, hour));
    }
    if (delta !== 0) drag.moved = true;
  }

  function handlePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    // A click beside the window moves the window there, keeping its width.
    if (drag?.mode === 'new' && !drag.moved && isZoomed) {
      const nextMin = clamp(drag.originHour - span / 2, 0, RACE_DURATION_HOURS - span);
      onChange(nextMin, nextMin + span);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 1 : 0.25;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const nextMin = clamp(windowMin + direction * step, 0, RACE_DURATION_HOURS - span);
      onChange(nextMin, nextMin + span);
    } else if (event.key === 'Escape' && isZoomed) {
      onChange(0, RACE_DURATION_HOURS);
    }
  }

  const percent = (hour: number) => `${(hour / RACE_DURATION_HOURS) * 100}%`;

  return (
    <div className="race-timeline-brush">
      <div
        ref={trackRef}
        className="race-timeline-brush-track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        {nights.map(([start, end]) => (
          <span
            key={start}
            className="race-timeline-brush-night"
            style={{ left: percent(start), width: percent(end - start) }}
          />
        ))}
        <svg viewBox={`0 0 ${RACE_DURATION_HOURS * 10} 40`} preserveAspectRatio="none" aria-hidden>
          {sparklines.map((sparkline) => (
            <polyline key={sparkline.key} points={sparkline.points} stroke={sparkline.color} />
          ))}
        </svg>
        {nowHour != null && <span className="race-timeline-brush-now" style={{ left: percent(nowHour) }} />}
        <div
          className={`race-timeline-brush-window${isZoomed ? ' is-zoomed' : ''}`}
          style={{ left: percent(windowMin), width: percent(span) }}
          data-brush="move"
          role="slider"
          tabIndex={0}
          aria-label="Zichtbaar tijdvenster"
          aria-valuemin={0}
          aria-valuemax={RACE_DURATION_HOURS}
          aria-valuenow={Math.round(windowMin * 100) / 100}
          aria-valuetext={`${formatRaceHour(windowMin)} tot ${formatRaceHour(windowMax)}`}
          onKeyDown={handleKeyDown}
        >
          <span className="race-timeline-brush-handle" data-brush="start" />
          <span className="race-timeline-brush-handle" data-brush="end" />
        </div>
      </div>
      <div className="race-timeline-brush-caption">
        <span>
          {isZoomed ? 'Ingezoomd op' : 'Hele race'} {formatRaceHour(windowMin)}–{formatRaceHour(windowMax)}
          <small>
            {formatRaceClock(raceStartedAt, windowMin)}–{formatRaceClock(raceStartedAt, windowMax)}
          </small>
        </span>
        <span className="race-timeline-brush-hint">
          {isZoomed
            ? 'Versleep het venster, of dubbelklik op de grafiek om uit te zoomen.'
            : 'Sleep over de grafiek of over deze strook om in te zoomen.'}
        </span>
      </div>
    </div>
  );
}

function buildSeriesData(
  view: TimelineView,
  baseline: SeriesKey,
  timeline: LapTimelinePoint[],
  hourly: HourlyLapCountPoint[],
  hasOwnHistory: boolean,
  hasRivalHistory: boolean
): SeriesData[] {
  const keys = SERIES.map((series) => series.key).filter(
    (key) => (key !== 'own' || hasOwnHistory) && (key !== 'rival' || hasRivalHistory)
  );
  // Chart.js draws the first dataset on top, so live stays above the comparison lines.
  return keys.map((key) => {
    const valueKey = VALUE_KEYS[key];
    if (view === 'hourly') {
      return { key, points: hourly.map((point) => ({ x: point.raceHour + 0.5, y: point[valueKey] })) };
    }
    const baselineKey = VALUE_KEYS[baseline];
    return {
      key,
      points: timeline.map((point) => {
        const value = point[valueKey];
        const baselineValue = point[baselineKey];
        if (view === 'total') return { x: point.raceHour, y: value };
        return { x: point.raceHour, y: value == null || baselineValue == null ? null : value - baselineValue };
      }),
    };
  });
}

function buildSparklines(seriesData: SeriesData[], hiddenSeries: ReadonlySet<SeriesKey>) {
  const visibleSeries = seriesData.filter((series) => !hiddenSeries.has(series.key));
  const values = visibleSeries.flatMap((series) =>
    series.points.flatMap((point) => (point.y == null ? [] : [point.y]))
  );
  if (!values.length) return [];
  const minimum = Math.min(...values);
  const range = Math.max(1e-6, Math.max(...values) - minimum);
  return visibleSeries.map((series) => ({
    key: series.key,
    color: SERIES.find((candidate) => candidate.key === series.key)!.cssColor,
    points: series.points
      .filter((point, index) => point.y != null && (series.points.length < 100 || index % 5 === 0))
      .map((point) => `${(point.x * 10).toFixed(1)},${(37 - ((point.y! - minimum) / range) * 34).toFixed(1)}`)
      .join(' '),
  }));
}

function resolveTimeWindow(timeWindow: TimeWindow, elapsedHours: number): [number, number] {
  if (timeWindow.kind === 'full') return [0, RACE_DURATION_HOURS];
  if (timeWindow.kind === 'custom') return [timeWindow.min, timeWindow.max];
  const end = clamp(elapsedHours, timeWindow.hours, RACE_DURATION_HOURS);
  return [end - timeWindow.hours, end];
}

function customTimeWindow(min: number, max: number): TimeWindow {
  const start = clamp(Math.min(min, max), 0, RACE_DURATION_HOURS - MIN_WINDOW_HOURS);
  const end = clamp(Math.max(max, start + MIN_WINDOW_HOURS), MIN_WINDOW_HOURS, RACE_DURATION_HOURS);
  return start <= 0 && end >= RACE_DURATION_HOURS ? { kind: 'full' } : { kind: 'custom', min: start, max: end };
}

function isInsidePlot(chart: Chart, x: number) {
  return x >= chart.chartArea.left && x <= chart.chartArea.right;
}

function timeTickStep(spanHours: number): number {
  if (spanHours >= 12) return 2;
  if (spanHours >= 6) return 1;
  if (spanHours >= 3) return 0.5;
  if (spanHours >= 1.5) return 0.25;
  return 1 / 6;
}

function formatLapValue(value: number, signed: boolean, fractionDigits: number): string {
  const rounded = Number(value.toFixed(fractionDigits));
  const text = Math.abs(rounded).toLocaleString('nl-BE', { maximumFractionDigits: fractionDigits });
  if (!signed || rounded === 0) return rounded < 0 ? `−${text}` : text;
  return `${rounded > 0 ? '+' : '−'}${text}`;
}

function timelineChartOptions(
  view: TimelineView,
  baseline: SeriesKey,
  windowMin: number,
  windowMax: number,
  raceStartedAt: number
): NonNullable<ChartConfiguration<'line'>['options']> {
  const baselineLabel = SERIES.find((series) => series.key === baseline)!.shortLabel;
  const isGap = view === 'gap';
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    normalized: true,
    interaction: { mode: 'index', axis: 'x', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...chartTooltipColors(),
        padding: 10,
        boxPadding: 4,
        itemSort: (first, second) => (second.parsed.y ?? 0) - (first.parsed.y ?? 0),
        callbacks: {
          title(items) {
            const hour = Number(items[0]?.parsed.x ?? 0);
            if (view === 'hourly') {
              const raceHour = Math.floor(hour);
              return `Uur ${raceHour + 1} · ${formatRaceHourWindow(raceStartedAt, raceHour)}`;
            }
            return `${formatRaceHour(hour)} · ${formatRaceClock(raceStartedAt, hour)}`;
          },
          label(context) {
            const value = context.parsed.y;
            if (value == null) return `${context.dataset.label}: geen data`;
            if (isGap) return `${context.dataset.label}: ${formatLapValue(value, true, 1)} rondes`;
            return `${context.dataset.label}: ${formatLapValue(value, false, view === 'hourly' ? 1 : 0)} rondes`;
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        min: windowMin,
        max: windowMax,
        // Ticks on round times (4u30, 5u) rather than counted from wherever the window starts.
        afterBuildTicks: (scale) => {
          const step = timeTickStep(windowMax - windowMin);
          const ticks = [];
          for (let tick = Math.ceil(windowMin / step - 1e-9) * step; tick <= windowMax + 1e-9; tick += step) {
            ticks.push({ value: Math.round(tick * 1_000) / 1_000 });
          }
          scale.ticks = ticks;
        },
        ticks: {
          color: workspaceChartPalette.muted,
          maxRotation: 0,
          autoSkipPadding: 16,
          callback: (value) => [formatRaceHour(Number(value)), formatRaceClock(raceStartedAt, Number(value))],
        },
        grid: { color: workspaceChartPalette.grid },
        border: { display: false },
      },
      y: {
        type: 'linear',
        grace: isGap ? '12%' : '6%',
        title: {
          display: true,
          text: isGap ? `Rondes t.o.v. ${baselineLabel}` : view === 'hourly' ? 'Rondes per uur' : 'Rondes',
          color: workspaceChartPalette.muted,
          font: { weight: 500 },
        },
        ticks: {
          color: workspaceChartPalette.muted,
          precision: isGap ? 1 : 0,
          callback: (value) => formatLapValue(Number(value), isGap, 1),
        },
        grid: {
          color: (context) =>
            isGap && context.tick?.value === 0 ? workspaceChartPalette.line : workspaceChartPalette.grid,
          lineWidth: (context) => (isGap && context.tick?.value === 0 ? 1.5 : 1),
        },
        border: { display: false },
      },
    },
  };
}

function raceDecorPlugin(decor: ChartDecor): Plugin<'line'> {
  return {
    id: 'raceDecor',
    afterLayout(chart) {
      decor.onLayout?.(chart);
    },
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      // The chart is created empty and configured right after, so the first draw has no time axis yet.
      if (!chartArea || !scales.x) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
      ctx.clip();
      for (const [start, end] of decor.nights) {
        const left = scales.x.getPixelForValue(start);
        const right = scales.x.getPixelForValue(end);
        if (right <= chartArea.left || left >= chartArea.right) continue;
        ctx.fillStyle = workspaceChartPalette.band;
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
        ctx.fillStyle = workspaceChartPalette.muted;
        ctx.font = `500 11px ${Chart.defaults.font.family}`;
        ctx.textBaseline = 'top';
        ctx.fillText('nacht', Math.max(left, chartArea.left) + 8, chartArea.top + 8);
      }
      ctx.restore();
    },
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales.x) return;
      ctx.save();
      if (decor.nowHour != null) {
        const x = scales.x.getPixelForValue(decor.nowHour);
        if (x >= chartArea.left && x <= chartArea.right) {
          ctx.strokeStyle = workspaceChartPalette.muted;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = workspaceChartPalette.muted;
          ctx.font = `600 11px ${Chart.defaults.font.family}`;
          ctx.textAlign = x > chartArea.right - 30 ? 'right' : 'left';
          ctx.textBaseline = 'top';
          ctx.fillText('nu', x + (ctx.textAlign === 'right' ? -5 : 5), chartArea.top + 8);
        }
      }
      const activeElement = chart.tooltip?.getActiveElements()[0];
      if (activeElement) {
        ctx.strokeStyle = workspaceChartPalette.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(activeElement.element.x, chartArea.top);
        ctx.lineTo(activeElement.element.x, chartArea.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}
