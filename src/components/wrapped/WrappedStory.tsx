import type React from 'react';
import { chartHours, formatLapTime, formatTimeOfDay, type WrappedRunner } from '../../lib/wrapped';

/**
 * One runner's Wrapped: four 1080×1920 story images, a copy of the Canva design
 * "24 urenloop WRAPPED". The boxes, flags and the car are the design's own drawings
 * (public/wrapped/page-N.svg); this file puts the text and the chart on top. Every x, y,
 * size and angle comes from the design's PDF. x and y are where the baseline starts.
 * Text with data-fit shrinks when a long name or number would run out of its box.
 */
export function WrappedStory({
  runner,
  year,
  raceStartedAt,
}: {
  runner: WrappedRunner;
  year: number;
  raceStartedAt: number | null;
}) {
  const fastest = runner.fastestLapMs != null ? formatLapTime(runner.fastestLapMs) : '–';
  const average = runner.averageLapMs != null ? formatLapTime(runner.averageLapMs) : '–';
  const type = runner.runnerType.title.toLocaleUpperCase('nl-BE');
  return (
    <>
      <Page number={1} year={year} label={`Wrapped van ${runner.name}`}>
        <Text x={84.3} y={492.9} className="wrapped-racing wrapped-orange" size={225.98} fit={930}>
          {runner.firstName.toLocaleUpperCase('nl-BE')}
        </Text>
        <Text x={86.4} y={671.5} className="wrapped-bebas wrapped-tight" size={165.63} fit={480}>
          {runner.lastName}
        </Text>
        <Text x={63.2} y={839.4} angle={5.74} className="wrapped-bebas" size={46.66}>
          Aantal rondes
        </Text>
        <Text x={111.5} y={1189.5} angle={5.68} className="wrapped-spartan" size={290.69} fit={390}>
          {runner.laps}
        </Text>
        <Text x={582.2} y={701.5} angle={-7.34} className="wrapped-bebas wrapped-night" size={46.66}>
          Snelste ronde
        </Text>
        <Text x={559.3} y={895.8} angle={-6.97} className="wrapped-spartan wrapped-night" size={93.33} fit={360}>
          {fastest}
        </Text>
        <Text x={588.5} y={1071.8} angle={-1.99} className="wrapped-bebas" size={46.66}>
          Gemiddelde tijd
        </Text>
        <Text x={579.6} y={1263.3} angle={-2.37} className="wrapped-spartan" size={93.33} fit={420}>
          {average}
        </Text>
        <Text x={444.7} y={1383} angle={-6.35} className="wrapped-bebas wrapped-night" size={46.66}>
          Looptype
        </Text>
        <Text x={117.5} y={1565.4} angle={-6.52} className="wrapped-racing wrapped-orange" size={102.28} fit={470}>
          {type}
        </Text>
        <Text x={665.7} y={1444.6} angle={1.03} className="wrapped-bebas" size={46.66}>
          Totale afstand
        </Text>
        <Text x={667} y={1597.1} angle={1.41} className="wrapped-spartan" size={93.33} fit={390}>
          {runner.meters.toLocaleString('nl-BE')}
        </Text>
      </Page>

      <Page number={2} year={year} label={`${runner.laps} rondes`}>
        <Text x={108} y={397.8} className="wrapped-bebas wrapped-orange" size={66.66} fit={900}>
          {runner.firstName}, je liep
        </Text>
        <Text x={-32.8} y={1372.3} className="wrapped-spartan" size={1041.64} fit={1060}>
          {runner.laps}
        </Text>
        <Text x={108} y={1560.8} className="wrapped-racing wrapped-orange" size={160.01}>
          {runner.laps === 1 ? 'RONDE' : 'RONDES'}
        </Text>
        {runner.lapsBeatenPercent > 0 && (
          <Text x={86.3} y={1804.8} className="wrapped-bebas" size={54.66}>
            meer dan {runner.lapsBeatenPercent}% van alle lopers
          </Text>
        )}
        <Text x={1003} y={1804.8} anchor="end" className="wrapped-bebas" size={54.66}>
          {runner.meters} meter
        </Text>
      </Page>

      {runner.fastestLap && (
        <Page number={3} year={year} label={`Snelste ronde ${fastest}`}>
          <Text x={52.9} y={566.4} className="wrapped-bebas wrapped-night" size={186.23}>
            Jouw snelste
          </Text>
          <Text x={52.9} y={743.7} className="wrapped-racing wrapped-night" size={186.25}>
            RONDE
          </Text>
          <Text x={52.8} y={1285.4} angle={4.05} className="wrapped-spartan wrapped-night" size={325.89} fit={980}>
            {fastest}
          </Text>
          <Text x={108} y={1660.6} className="wrapped-bebas wrapped-night" size={53.33}>
            ronde {runner.fastestLap.number}
          </Text>
          <Text x={972} y={1660.6} anchor="end" className="wrapped-bebas wrapped-night" size={53.33}>
            {formatTimeOfDay(runner.fastestLap.finishedAt)}
          </Text>
          <text x={108} y={1842.8} className="wrapped-blue">
            <tspan className="wrapped-racing" fontSize={124.21}>
              #{runner.fastestLap.place}
            </tspan>
            <tspan className="wrapped-bebas" fontSize={62.92} dx={14} dy={-5.2}>
              {' van Apolloon'}
            </tspan>
          </text>
        </Page>
      )}

      <Page number={4} year={year} label={`Looptype ${runner.runnerType.title}`}>
        <Text x={108} y={515.5} className="wrapped-bebas" size={66.66}>
          jouw looptype
        </Text>
        <Text x={55.1} y={837.6} className="wrapped-racing wrapped-orange" size={214.81} fit={970}>
          {type}
        </Text>
        <HourChart runner={runner} raceStartedAt={raceStartedAt} />
        <foreignObject x={108} y={1187} width={900} height={240}>
          <p className="wrapped-story__type-text">{runner.runnerType.text}</p>
        </foreignObject>
      </Page>
    </>
  );
}

function Page({
  number,
  year,
  label,
  children,
}: {
  number: number;
  year: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`wrapped-story wrapped-story--${number}`} aria-label={label}>
      <span className="brand-mark wrapped-story__logo" role="img" aria-label="Apolloon" />
      <svg className="wrapped-story__text" viewBox="0 0 1080 1920" aria-hidden="true">
        <text x={507.8} y={204.2} className="wrapped-bebas" fontSize={45.33}>
          {'24 urenloop - '}
          <tspan className="wrapped-racing" fontSize={40} dy={-2.8}>
            WRAPPED
          </tspan>
          <tspan dy={2.8}>{` - ${year}`}</tspan>
        </text>
        {children}
      </svg>
    </section>
  );
}

function Text({
  x,
  y,
  angle = 0,
  size,
  fit,
  anchor,
  className,
  children,
}: {
  x: number;
  y: number;
  /** Degrees counterclockwise, as the design tilts its boxes. */
  angle?: number;
  size: number;
  /** The widest the text may get, in px; it shrinks to fit. */
  fit?: number;
  anchor?: 'end';
  className: string;
  children: React.ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      transform={angle ? `rotate(${-angle} ${x} ${y})` : undefined}
      className={className}
      fontSize={size}
      textAnchor={anchor}
      data-fit={fit}
    >
      {children}
    </text>
  );
}

// The chart's 24 hours sit between these x positions, on a baseline at CHART_BOTTOM.
const CHART_LEFT = 114;
const CHART_RIGHT = 961;
const CHART_BOTTOM = 1772;
const BAR_MAX = 243;
const BAR_WIDTH = 30;

/** Laps per hour of the race: orange for the hours the runner type is about, a dot for an hour without laps. */
function HourChart({ runner, raceStartedAt }: { runner: WrappedRunner; raceStartedAt: number | null }) {
  const slot = (CHART_RIGHT - CHART_LEFT) / 24;
  const most = Math.max(...runner.lapsPerHour);
  const hours = raceStartedAt != null ? chartHours(raceStartedAt) : null;
  const window = runner.runnerType.hours;
  // The first and last hour, and every 00, 06, 12 and 18 o'clock that is not crowding them.
  const labels = (hours ?? [])
    .map((hour, index) => ({ hour, index }))
    .filter(({ hour, index }) => index === 0 || index === 24 || (hour % 6 === 0 && index > 2 && index < 22));
  return (
    <g>
      {runner.lapsPerHour.map((laps, index) => {
        const middle = CHART_LEFT + slot * (index + 0.5);
        const height = laps ? Math.max(BAR_WIDTH, (BAR_MAX * laps) / most) : 0;
        const hour = hours?.[index];
        const highlighted = window != null && hour != null && hour >= window.from && hour < window.to;
        return (
          <g key={index}>
            <ellipse cx={middle} cy={CHART_BOTTOM - 6.5} rx={14} ry={6.5} className="wrapped-story__dot" />
            {laps > 0 && (
              <rect
                x={middle - BAR_WIDTH / 2}
                y={CHART_BOTTOM - height}
                width={BAR_WIDTH}
                height={height}
                rx={BAR_WIDTH / 2}
                className={highlighted ? 'wrapped-story__bar wrapped-story__bar--on' : 'wrapped-story__bar'}
              />
            )}
          </g>
        );
      })}
      {labels.map(({ hour, index }) => (
        <text
          key={index}
          x={CHART_LEFT + slot * index}
          y={1825}
          textAnchor={index === 0 ? 'start' : index === 24 ? 'end' : 'middle'}
          className="wrapped-story__hour"
        >
          {String(hour).padStart(2, '0')}U
        </text>
      ))}
    </g>
  );
}
