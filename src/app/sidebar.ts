import React from 'react';

// Sidebar collapsed/expanded, remembered per browser. Without a choice,
// narrow laptops start collapsed and wider screens expanded.
const STORAGE_KEY = 'apolloon.sidebar';
const NARROW_QUERY = '(max-width: 1180px)';

type SidebarChoice = 'collapsed' | 'expanded' | null;

function readChoice(): SidebarChoice {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'collapsed' || stored === 'expanded' ? stored : null;
  } catch {
    return null;
  }
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const [choice, setChoice] = React.useState<SidebarChoice>(readChoice);
  const [narrow, setNarrow] = React.useState(() => window.matchMedia(NARROW_QUERY).matches);

  React.useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const collapsed = choice ? choice === 'collapsed' : narrow;
  const toggle = React.useCallback(() => {
    const next = collapsed ? 'expanded' : 'collapsed';
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the choice for this session only.
    }
    setChoice(next);
  }, [collapsed]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'b' || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  return [collapsed, toggle];
}
