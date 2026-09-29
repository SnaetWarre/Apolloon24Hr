import React from 'react';

export type AdminNotice = { tone: 'success' | 'error'; text: string };

/** Busy flag and the outcome message of the last action in one admin panel. */
export function useAdminAction() {
  const [pending, setPending] = React.useState(false);
  const [notice, setNotice] = React.useState<AdminNotice | null>(null);

  const run = React.useCallback(
    async <T,>(action: () => Promise<T>, success: string | ((result: T) => string), failure: string) => {
      setPending(true);
      setNotice(null);
      try {
        const result = await action();
        setNotice({
          tone: 'success',
          text: typeof success === 'function' ? success(result) : success,
        });
        return result;
      } catch (error) {
        setNotice({
          tone: 'error',
          text: error instanceof Error ? error.message : failure,
        });
        return null;
      } finally {
        setPending(false);
      }
    },
    []
  );

  return { pending, notice, setNotice, run };
}

export function AdminNoticeBanner({ notice }: { notice: AdminNotice | null }) {
  if (!notice) return null;
  return notice.tone === 'error' ? (
    <div className="warning-banner warning-banner--blocking" role="alert">
      {notice.text}
    </div>
  ) : (
    <div className="success-banner" role="status" aria-live="polite">
      {notice.text}
    </div>
  );
}
