import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/router';

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/trpc',
      // Which screen made a change, for Beheer › Activiteit.
      headers: () => ({ 'x-apolloon-screen': window.location.pathname }),
    }),
  ],
});
