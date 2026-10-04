import { queryOptions, useQuery } from '@tanstack/react-query';
import type { RunnerRegistration } from '../types';
import { registrationsKey } from './snapshot';

const noRegistrations: Record<string, RunnerRegistration> = {};

/** Registration form answers by runner id; only operator screens that need contact details load them. */
export const registrationsQuery = queryOptions({
  queryKey: registrationsKey,
  queryFn: async () => {
    const response = await fetch('/api/registrations');
    if (!response.ok) throw new Error(`Inschrijvingen laden mislukt (${response.status})`);
    return (await response.json()) as Record<string, RunnerRegistration>;
  },
});

export function useRegistrations(): Record<string, RunnerRegistration> {
  const query = useQuery(registrationsQuery);
  return query.data ?? noRegistrations;
}
