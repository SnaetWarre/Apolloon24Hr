import { Chart } from 'chart.js';
import { useResolvedTheme, type ResolvedTheme } from '../app/theme';

Chart.defaults.font.family = '"Geist", ui-sans-serif, system-ui, sans-serif';
Chart.defaults.font.size = 12;

// Chart.js draws on canvas, so it cannot use CSS variables directly.
// Every getter reads the current theme token; charts rebuild when useChartTheme() changes.
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export const workspaceChartPalette = {
  get text() { return token('--chart-text', '#3F4E63'); },
  get muted() { return token('--chart-muted', '#5F6E83'); },
  get grid() { return token('--chart-grid', '#E1E7EF'); },
  get surface() { return token('--surface', '#FFFFFF'); },
  get ink() { return token('--ink', '#0C1A2B'); },
  get line() { return token('--line-2', '#B7C3D1'); },
  /** Apolloon live data. */
  get live() { return token('--series-live', '#0D78D3'); },
  get liveFill() { return token('--series-live-fill', 'rgb(13 120 211 / 0.18)'); },
  /** Planned or target line. */
  get target() { return token('--series-target', '#7C8A9E'); },
  /** Apolloon previous edition. */
  get own() { return token('--series-own', '#7C3AED'); },
  /** Rival previous edition. */
  get rival() { return token('--series-rival', '#B7791F'); },
  /** High-contrast neutral series (median, reference). */
  get strong() { return token('--series-strong', '#0C1A2B'); },
  get neutral() { return token('--series-neutral', '#8A97A8'); },
  get accent() { return token('--series-accent', '#0A62AE'); },
};

/** Include in a chart effect's dependencies so it redraws (same data) after a theme switch. */
export function useChartTheme(): ResolvedTheme {
  return useResolvedTheme();
}

/** Tooltip colours from the active theme; Chart.js defaults assume a dark tooltip. */
export function chartTooltipColors() {
  return {
    backgroundColor: workspaceChartPalette.surface,
    titleColor: workspaceChartPalette.ink,
    bodyColor: workspaceChartPalette.text,
    borderColor: workspaceChartPalette.line,
    borderWidth: 1,
  };
}
