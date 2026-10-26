/** Competitions that fit on the Competitiescherm. */
export const MAX_COMPETITIONS = 6;

/** The same teams give the same key, whatever order they were picked in. */
export function competitionKey(labelIds: readonly string[]) {
  return [...labelIds].sort().join('.');
}
