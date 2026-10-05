export function runnerFormError(name: string): string | null {
  if (!name.trim()) return 'Naam is verplicht.';
  return null;
}
