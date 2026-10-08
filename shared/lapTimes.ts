/** Real laps take minutes; a lap shorter than this is a double press, so Timing asks before it counts. */
export const MIN_LAP_MS = 20_000;

/**
 * A lap this long means nobody handed off (the race sat idle or someone forgot
 * the button). It still counts as a lap, but its time would wreck every average.
 */
export const MAX_PLAUSIBLE_LAP_MS = 10 * 60_000;
