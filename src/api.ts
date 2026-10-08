import { createTRPCClient, httpBatchLink, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '../server/router';
import { CHANGE_NOT_SAVED, CONNECTION_LOST, isConnectionError } from './lib/connectionError';

/** A call that cannot reach the laptop's server fails with a Dutch message instead of the browser's. */
const dutchConnectionErrors: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    observable((observer) =>
      next(op).subscribe({
        next: (value) => observer.next(value),
        error: (error) =>
          observer.error(
            isConnectionError(error)
              ? new TRPCClientError(op.type === 'mutation' ? CHANGE_NOT_SAVED : CONNECTION_LOST, { cause: error })
              : error
          ),
        complete: () => observer.complete(),
      })
    );

export const trpc = createTRPCClient<AppRouter>({
  links: [
    dutchConnectionErrors,
    httpBatchLink({
      url: '/trpc',
      // Which screen made a change, for Beheer › Activiteit.
      headers: () => ({ 'x-apolloon-screen': window.location.pathname }),
    }),
  ],
});
