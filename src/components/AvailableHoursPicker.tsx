import React from 'react';
import { useRegistrations } from '../app/index';
import { buildHourGrid, formatMomentBlock, hasHourBlock, hoursOutsideGrid, toggleHourBlock } from '../lib/availability';

/** Hour blocks in the registration form's own format, so hand-entered hours filter and match like imported ones. */
export function AvailableHoursPicker({ value, onChange }: { value: string[]; onChange: (hours: string[]) => void }) {
  const registrations = useRegistrations();
  const registeredHours = React.useMemo(
    () => Object.values(registrations).flatMap((registration) => registration.availableHours),
    [registrations]
  );
  const grid = React.useMemo(() => buildHourGrid([...registeredHours, ...value]), [registeredHours, value]);
  const otherHours = hoursOutsideGrid(value, grid);

  return (
    <fieldset className="hours-picker">
      <legend>Beschikbare uren</legend>
      {grid.map((day) => (
        <div key={day.weekday} className="hours-picker__day">
          <span className="hours-picker__weekday">{day.weekday}</span>
          <div className="hours-picker__hours">
            {day.hours.map((hour) => {
              const block = formatMomentBlock({ hour, weekday: day.weekday });
              return (
                <label key={hour} className="check-pill hours-picker__hour" title={block}>
                  <input
                    type="checkbox"
                    aria-label={block}
                    checked={hasHourBlock(value, day.weekday, hour)}
                    onChange={() => onChange(toggleHourBlock(value, day.weekday, hour))}
                  />
                  <span>{String(hour).padStart(2, '0')}u</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {otherHours.length > 0 && (
        <div className="hours-picker__day">
          <span className="hours-picker__weekday">Andere</span>
          <div className="hours-picker__hours">
            {otherHours.map((text) => (
              <label key={text} className="check-pill">
                <input
                  type="checkbox"
                  checked
                  onChange={() => onChange(value.filter((selected) => selected !== text))}
                />
                <span>{text}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </fieldset>
  );
}
