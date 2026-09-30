import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: Infinity,
      // Keep what a page loaded while it is closed, so going back to it is instant instead of empty.
      gcTime: Infinity,
      refetchOnWindowFocus: false,
    },
  },
});
