import React from 'react';

export type CopyResult = 'copied' | 'manual';

/**
 * Copies text from a click. navigator.clipboard only exists in secure contexts
 * (https or localhost), so laptops that open Apolloon via http://<LAN-IP> fall
 * back to a hidden textarea, and finally to a prompt with the text selected.
 */
async function copyText(text: string): Promise<CopyResult> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      // Permission denied or unavailable; try the fallback below.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  if (copied) return 'copied';
  window.prompt('Kopiëren lukt hier niet automatisch. Kopieer het adres hieronder met Ctrl+C:', text);
  return 'manual';
}

/** Copy action plus a short "Gekopieerd" confirmation. */
export function useCopyText(text: string | null): [boolean, () => void] {
  const [copied, setCopied] = React.useState(false);
  const copy = React.useCallback(() => {
    if (!text) return;
    void copyText(text).then((result) => {
      if (result !== 'copied') return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return [copied, copy];
}
