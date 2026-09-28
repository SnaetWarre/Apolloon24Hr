export function runnerFormError(name: string, targetLaps: string): string | null {
  if (!name.trim()) return 'Naam is verplicht.';
  if (targetLaps.trim()) {
    const lapTarget = Number(targetLaps);
    if (!Number.isSafeInteger(lapTarget) || lapTarget < 0) {
      return 'Het doel moet een geheel aantal rondes zijn (0 of meer).';
    }
  }
  return null;
}
