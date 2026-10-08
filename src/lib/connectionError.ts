import { TRPCClientError } from '@trpc/client';

// The browser words a request that never got an answer in English ("Failed to fetch"); screens show these instead.
export const CONNECTION_LOST = 'Geen verbinding met de laptop';
export const CHANGE_NOT_SAVED = 'Niet opgeslagen: geen verbinding met de laptop. Probeer opnieuw.';

/** True when a request never reached the laptop's server: it is restarting, off, or the cable is out. */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof TRPCClientError) return !error.shape && isConnectionError(error.cause);
  return error instanceof TypeError;
}

/** `fetch`, failing with the Dutch message when the laptop's server cannot be reached. */
export function fetchFromLaptop(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init).catch((error: unknown) => {
    throw connectionLostError(error);
  });
}

export function connectionLostError(error: unknown): unknown {
  return isConnectionError(error) ? new Error(CONNECTION_LOST, { cause: error }) : error;
}
