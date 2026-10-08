import { queryOptions } from '@tanstack/react-query';
import { fetchFromLaptop } from '../lib/connectionError';

export const BUNDLED_REFERENCE_URL = '/reference/quivr-2025-lap-times.json';

/** Last year's lap times that ship with the app, for Tactiek. Loaded once per session, and before Tactiek opens. */
export const bundledReferenceQuery = queryOptions({
  queryKey: ['reference', 'bundled'],
  queryFn: async () => {
    const response = await fetchFromLaptop(BUNDLED_REFERENCE_URL);
    if (!response.ok) throw new Error(`Quivr-referentie laden mislukt (${response.status}).`);
    return response.text();
  },
});
