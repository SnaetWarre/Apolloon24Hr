import React from 'react';
import { setThemePreference, useThemePreference, type ThemePreference } from '../app/theme';

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  {
    value: 'light',
    label: 'Licht',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Donker',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      </svg>
    ),
  },
];

/**
 * Buttons (not radio inputs) on purpose: on Timing, Space stays the timing key
 * even when this control has focus, exactly like the navigation links.
 */
export function ThemeSwitch() {
  const preference = useThemePreference();
  const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = OPTIONS.findIndex((option) => option.value === preference);
    const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : OPTIONS.length - 1)) % OPTIONS.length;
    setThemePreference(OPTIONS[nextIndex].value);
    buttonRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="theme-switch" role="radiogroup" aria-label="Thema" onKeyDown={onKeyDown}>
      {OPTIONS.map((option, index) => {
        const checked = option.value === preference;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={`Thema: ${option.label}`}
            aria-label={option.label}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
          </button>
        );
      })}
    </div>
  );
}
