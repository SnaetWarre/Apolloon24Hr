import React from 'react';
import { eventHourGrid, formatMomentBlock, hasHourBlock, setHourBlock } from '../lib/availability';

const GRID = eventHourGrid();

/**
 * The event's one-hour slots in the registration form's own format, so
 * hand-entered hours filter and match like imported ones. Press one slot,
 * or press and drag across a stretch to set it in one go.
 */
export function AvailableHoursPicker({ value, onChange }: { value: string[]; onChange: (hours: string[]) => void }) {
  // What a drag paints: the opposite of the slot it started on.
  const paint = React.useRef<boolean | null>(null);

  React.useEffect(() => {
    const stop = () => {
      paint.current = null;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  function startPaint(weekday: string, hour: number) {
    paint.current = !hasHourBlock(value, weekday, hour);
    onChange(setHourBlock(value, weekday, hour, paint.current));
  }

  function continuePaint(weekday: string, hour: number) {
    if (paint.current === null || hasHourBlock(value, weekday, hour) === paint.current) return;
    onChange(setHourBlock(value, weekday, hour, paint.current));
  }

  return (
    <fieldset className="hours-picker">
      <legend>Beschikbare uren</legend>
      {GRID.map((day) => (
        <div key={day.weekday} className="hours-picker__day">
          <span className="hours-picker__weekday">{day.weekday}</span>
          <div className="hours-picker__hours">
            {day.hours.map((hour) => {
              const block = formatMomentBlock({ hour, weekday: day.weekday });
              return (
                <button
                  key={hour}
                  type="button"
                  className="hours-picker__slot"
                  aria-pressed={hasHourBlock(value, day.weekday, hour)}
                  aria-label={block}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    startPaint(day.weekday, hour);
                  }}
                  onPointerEnter={() => continuePaint(day.weekday, hour)}
                  onKeyDown={(event) => {
                    if (event.key !== ' ' && event.key !== 'Enter') return;
                    event.preventDefault();
                    startPaint(day.weekday, hour);
                  }}
                >
                  {pad(hour)}–{pad((hour + 1) % 24)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className="label-picker-help">Sleep over meerdere uren om ze in één keer aan of uit te zetten.</p>
    </fieldset>
  );
}

function pad(hour: number) {
  return String(hour).padStart(2, '0');
}
