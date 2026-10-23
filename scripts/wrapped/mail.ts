import path from 'path';
import { fileURLToPath } from 'url';
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
  /** Sends one runner's Wrapped to the sender's own address and changes nothing in the manifest. */
  testOnly: boolean;
};

/** One mail tried: `error` is null when it went out. */
export type WrappedMailProgress = {
  done: number;
  total: number;
  card: WrappedManifestEntry;
  to: string;
  error: string | null;
};

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
      const to = input.testOnly ? input.from : card.email;
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await transport.sendMail(message(input, card, to));
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
        onProgress?.({ done: index + 1, total: queue.length, card, to, error: reason });
        continue;
      }
      result.sent += 1;
      if (!input.testOnly) {
        card.sentAt = Date.now();
        card.error = null;
        await writeManifest(input.folder, manifest);
      }
      onProgress?.({ done: index + 1, total: queue.length, card, to, error: null });
    }
  } finally {
    transport.close();
  }
  result.left = input.testOnly ? 0 : mailableCards(manifest).length;
  return result;
}

// Mail apps ignore stylesheets and modern CSS, so the mail is tables with inline styles.
// Dark, in the colours of the Wrapped pages.
const NIGHT = '#0a1037';
const DEEP = '#05081f';
const LIGHT = '#e2e6ff';
const ORANGE = '#eb6c1d';
const LOGO = fileURLToPath(new URL('./apolloon-logo-white.png', import.meta.url));
/** The checkered strip from page 4, as table cells because mail apps drop background images. */
const CHECKERS = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${[0, 1]
  .map(
    (row) =>
      `<tr>${Array.from(
        { length: 26 },
        (_, index) =>
          `<td height="10" style="height:10px;line-height:10px;font-size:0;background:${(index + row) % 2 ? NIGHT : LIGHT}">&nbsp;</td>`
      ).join('')}</tr>`
  )
  .join('')}</table>`;

function message(input: WrappedMailInput, card: WrappedManifestEntry, to: string) {
  const paragraphs = input.text
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
  // Two pages per row, each as wide as fits next to the other on a phone.
  const cells = card.files.map(
    (_, index) =>
      `<td style="padding:6px"><img src="cid:wrapped-${index + 1}" alt="Jouw 24u Wrapped, deel ${index + 1}" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0;border-radius:10px"></td>`
  );
  const pages = Array.from(
    { length: Math.ceil(cells.length / 2) },
    (_, row) => `<tr>${cells.slice(row * 2, row * 2 + 2).join('')}</tr>`
  ).join('');
  const html = `<!doctype html>
<html lang="nl"><head><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:${DEEP}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${DEEP}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${NIGHT};border-radius:16px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:${LIGHT}">
<tr><td style="padding:26px 28px 22px"><img src="cid:apolloon-logo" alt="Apolloon" width="140" style="display:block;border:0;width:140px;height:auto"></td></tr>
<tr><td style="padding:0">${CHECKERS}</td></tr>
<tr><td style="padding:28px 28px 8px;font-size:16px;line-height:1.5;color:${LIGHT}">${paragraphs}</td></tr>
<tr><td align="center" style="padding:4px 20px 20px"><table role="presentation" cellpadding="0" cellspacing="0">${pages}</table></td></tr>
<tr><td align="center" style="padding:0 28px 28px"><a href="https://www.instagram.com/" style="display:inline-block;background:${ORANGE};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px">Open Instagram</a></td></tr>
<tr><td style="padding:0 28px 28px;font-size:16px;line-height:1.5;color:${LIGHT}">Met trotse groeten,<br><strong style="color:${ORANGE}">Het hele Apolloon-team</strong></td></tr>
</table>
<p style="margin:16px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#6f7aa8">Apolloon, 24 Urenloop</p>
</td></tr></table>
</body></html>`;
  return {
    from: input.from,
    to,
    subject: input.subject,
    text: `${input.text}\n\nMet trotse groeten,\nHet hele Apolloon-team`,
    html,
    // The pages show in the mail and are attached once more, so they save to a phone in one tap.
    attachments: [
      { filename: 'apolloon.png', path: LOGO, cid: 'apolloon-logo' },
      ...card.files.map((file, index) => ({
        filename: file,
        path: path.join(input.folder, file),
        cid: `wrapped-${index + 1}`,
      })),
      ...card.files.map((file) => ({ filename: file, path: path.join(input.folder, file) })),
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
