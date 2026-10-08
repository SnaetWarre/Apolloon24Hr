import type React from 'react';

/** Opening a fold-out with fields puts the cursor in its first field, so typing can start right away. */
export function focusFirstInputOnOpen(event: React.SyntheticEvent<HTMLDetailsElement>) {
  if (event.currentTarget.open) event.currentTarget.querySelector<HTMLElement>('input, textarea')?.focus();
}
