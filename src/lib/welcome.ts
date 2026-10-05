import React from 'react';

const SKIPPED_KEY = 'apolloon.welcome';

/** Overzicht greets a laptop that has nothing yet, until it has runners or someone skips it. */
export function shouldShowWelcome({
  runnerCount,
  raceStarted,
  skipped,
}: {
  runnerCount: number;
  raceStarted: boolean;
  skipped: boolean;
}): boolean {
  return runnerCount === 0 && !raceStarted && !skipped;
}

/** Whether this browser chose to skip the welcome screen, remembered across restarts. */
export function useWelcomeSkipped(): [boolean, () => void] {
  const [skipped, setSkipped] = React.useState(() => {
    try {
      return window.localStorage.getItem(SKIPPED_KEY) === 'skipped';
    } catch {
      return false;
    }
  });
  const skip = React.useCallback(() => {
    try {
      window.localStorage.setItem(SKIPPED_KEY, 'skipped');
    } catch {
      // Skipped for this session only.
    }
    setSkipped(true);
  }, []);
  return [skipped, skip];
}
