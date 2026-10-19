import React from 'react';
import { useToast, type ToastMessage } from '../Toaster';

/** Busy flag for one admin panel; the outcome of each action shows as a toast. */
export function useAdminAction() {
  const toast = useToast();
  const [pending, setPending] = React.useState(false);

  const run = React.useCallback(
    async <T>(action: () => Promise<T>, success: string | ((result: T) => string | ToastMessage), failure: string) => {
      setPending(true);
      try {
        const result = await action();
        const message = typeof success === 'function' ? success(result) : success;
        toast({ tone: 'success', ...(typeof message === 'string' ? { text: message } : message) });
        return result;
      } catch (error) {
        toast({ tone: 'error', text: failure, detail: error instanceof Error ? error.message : undefined });
        return null;
      } finally {
        setPending(false);
      }
    },
    [toast]
  );

  return { pending, run };
}
