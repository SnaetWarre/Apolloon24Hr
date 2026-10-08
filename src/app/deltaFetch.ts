import { applyDelta, isDelta, type Delta } from '../../shared/delta';
import { fetchFromLaptop } from '../lib/connectionError';

/**
 * Fetches `url`, sending the revision this screen already holds so the server
 * answers with only what changed (`shared/delta.ts`). Loads everything when
 * the changes do not fit the copy held here.
 */
export async function fetchSinceBase<T extends { revision: number }>(
  url: string,
  base: T | null | undefined,
  describe: (response: Response) => Promise<Error>
): Promise<T> {
  for (const since of base ? [base.revision, null] : [null]) {
    const response = await fetchFromLaptop(
      since === null ? url : `${url}${url.includes('?') ? '&' : '?'}since=${since}`
    );
    if (!response.ok) throw await describe(response);
    const body = (await response.json()) as T | Delta<T>;
    if (!isDelta(body)) return body;
    try {
      if (base && body.since === base.revision) return applyDelta(base, body);
    } catch {
      // Load everything instead.
    }
  }
  throw new Error('Gegevens laden mislukt');
}
