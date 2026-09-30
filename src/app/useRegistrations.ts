import { queryOptions, useQuery } from '@tanstack/react-query';
import { trpc } from '../api';
import type { RunnerRegistration } from '../types';
import { registrationsKey } from './snapshot';

const noRegistrations: Record<string, RunnerRegistration> = {};

/** Registration form answers by runner id; only operator screens that need contact details load them. */
export const registrationsQuery = queryOptions({
  queryKey: registrationsKey,
  queryFn: () => trpc.runners.registrations.query(),
});

export function useRegistrations(): Record<string, RunnerRegistration> {
  const query = useQuery(registrationsQuery);
  return query.data ?? noRegistrations;
}
