export function runnerFormError(name: string, targetLaps: string): string | null {
  if (!name.trim()) return 'Naam is verplicht.';
  if (targetLaps.trim()) {
    const lapTarget = Number(targetLaps);
    if (!Number.isSafeInteger(lapTarget) || lapTarget < 0) {
      return 'Doelstelling toeren moet een geheel getal van 0 of meer zijn.';
    }
  }
  return null;
}
