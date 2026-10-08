// The Beheer tabs, which ?section= on /admin can name (see router.tsx).
export type AdminSection = 'preparation' | 'runners' | 'laps' | 'labels' | 'public' | 'activity' | 'system';

export const ADMIN_SECTIONS: ReadonlyArray<{ id: AdminSection; label: string }> = [
  { id: 'preparation', label: 'Voorbereiding' },
  { id: 'runners', label: 'Lopers' },
  { id: 'laps', label: 'Rondes' },
  { id: 'labels', label: 'Ploegen & labels' },
  { id: 'public', label: 'Publiek' },
  { id: 'activity', label: 'Activiteit' },
  { id: 'system', label: 'Systeem & herstel' },
];

export function isAdminSection(value: unknown): value is AdminSection {
  return ADMIN_SECTIONS.some((section) => section.id === value);
}
