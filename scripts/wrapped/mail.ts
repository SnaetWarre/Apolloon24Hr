import path from 'path';
import { createTransport } from 'nodemailer';
import { mailableCards, readManifest, writeManifest, type WrappedManifestEntry } from './manifest.ts';

/** Gmail over SMTP; the tests point it at a local server instead. */
export type SmtpServer = { host: string; port: number; secure: boolean; rejectUnauthorized?: boolean };
export const GMAIL: SmtpServer = { host: 'smtp.gmail.com', port: 465, secure: true };

export type WrappedMailInput = {
  folder: string;
  /** The sending Gmail address. */
  from: string;
  /** A Google app password. Only kept in memory while sending; never written anywhere. */
  password: string;
  subject: string;
  text: string;
  /** Sends one card to the sender's own address and changes nothing in the manifest. */
  testOnly: boolean;
};

export type WrappedMailProgress = { done: number; total: number; current: string | null };

export type WrappedMailResult = {
  sent: number;
  /** Still to send after this run, e.g. after a stop. */
  left: number;
  failed: Array<{ name: string; error: string }>;
  /** Why sending stopped before the end, in Dutch; null when it went through. */
  stopped: string | null;
};

/** Errors that hit every next mail too, so sending stops at once instead of failing 300 times. */
const STOPPING_CODES = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EPROTOCOL']);

export async function sendWrappedMails(
  input: WrappedMailInput,
  options: { server?: SmtpServer; delayMs?: number; onProgress?: (progress: WrappedMailProgress) => void } = {}
): Promise<WrappedMailResult> {
  const { server = GMAIL, delayMs = 2_000, onProgress } = options;
  const manifest = await readManifest(input.folder);
  if (!manifest) throw new Error('Geen kaarten in deze map. Maak eerst de kaarten.');

  const queue = input.testOnly ? manifest.cards.slice(0, 1) : mailableCards(manifest);
  const transport = createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user: input.from, pass: input.password },
    tls: server.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined,
  });
  const result: WrappedMailResult = { sent: 0, left: queue.length, failed: [], stopped: null };
  try {
    for (const [index, card] of queue.entries()) {
      onProgress?.({ done: index, total: queue.length, current: card.name });
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await transport.sendMail(message(input, card, input.testOnly ? input.from : card.email));
      } catch (error) {
        const stop = stoppingReason(error);
        if (stop) {
          result.stopped = stop;
          break;
        }
        const reason = error instanceof Error ? error.message : String(error);
        result.failed.push({ name: card.name, error: reason });
        if (!input.testOnly) {
          card.error = reason;
          await writeManifest(input.folder, manifest);
        }
        continue;
      }
      result.sent += 1;
      if (!input.testOnly) {
        card.sentAt = Date.now();
        card.error = null;
        await writeManifest(input.folder, manifest);
      }
    }
  } finally {
    transport.close();
  }
  result.left = input.testOnly ? 0 : mailableCards(manifest).length;
  onProgress?.({ done: queue.length, total: queue.length, current: null });
  return result;
}

function message(input: WrappedMailInput, card: WrappedManifestEntry, to: string) {
  const paragraphs = input.text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    from: input.from,
    to,
    subject: input.subject,
    text: input.text,
    html: `${paragraphs}<p><img src="cid:wrapped-card" alt="Jouw 24 Urenloop" width="360"></p>`,
    // Shown in the mail, and attached once more so it saves to a phone in one tap.
    attachments: [
      { filename: card.fileName, path: path.join(input.folder, card.fileName), cid: 'wrapped-card' },
      { filename: card.fileName, path: path.join(input.folder, card.fileName) },
    ],
  };
}

function stoppingReason(error: unknown): string | null {
  const { code, responseCode, response } = (error ?? {}) as { code?: string; responseCode?: number; response?: string };
  if (code === 'EAUTH' || responseCode === 535) {
    return 'Wachtwoord of adres klopt niet. Gebruik een app-wachtwoord van Google, niet het gewone wachtwoord.';
  }
  // Gmail answers "Daily user sending quota exceeded" once the day's limit (about 500) is reached.
  if (/quota|limit/i.test(response ?? '')) {
    return 'Gmail laat vandaag geen mails meer door. Probeer morgen opnieuw; wie al een mail kreeg, krijgt er geen tweede.';
  }
  if (code && STOPPING_CODES.has(code)) {
    return 'Geen verbinding met Gmail. Controleer de internetverbinding en probeer opnieuw.';
  }
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
