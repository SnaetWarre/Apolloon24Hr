import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { registrationsQuery, useAppData, useRaceHistory } from '../../app/index';
import { buildWrapped } from '../../lib/wrapped';
import type { LiveAppSnapshot } from '../../types';

const selectWrappedData = ({ runners, race }: LiveAppSnapshot) => ({ runners, race });

/** Every runner's Wrapped data, from the full lap history and the registration answers. */
export function useWrapped() {
  const { runners, race } = useAppData(selectWrappedData);
  const history = useRaceHistory({ scope: 'full' });
  const registrations = useQuery(registrationsQuery);
  const ready = history.initialized && registrations.isSuccess;
  const wrapped = React.useMemo(
    () =>
      ready
        ? buildWrapped({
            runners,
            laps: history.laps,
            registrations: registrations.data,
            raceStartedAt: race.raceStartedAt,
          })
        : [],
    [ready, runners, history.laps, registrations.data, race.raceStartedAt]
  );
  return { wrapped, ready, race, error: history.error ?? registrations.error };
}
