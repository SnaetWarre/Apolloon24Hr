export type DisplayHistoryObservation = {
  knownIds: Set<string>;
  shouldAnnounceLatest: boolean;
};

export function observeDisplayHistory(
  historyIsInitialized: boolean,
  previouslyKnownIds: ReadonlySet<string> | null,
  currentIds: readonly string[],
  latestRelevantId: string | null
): DisplayHistoryObservation | null {
  if (!historyIsInitialized) return null;

  return {
    knownIds: new Set(currentIds),
    shouldAnnounceLatest: Boolean(previouslyKnownIds && latestRelevantId && !previouslyKnownIds.has(latestRelevantId)),
  };
}
