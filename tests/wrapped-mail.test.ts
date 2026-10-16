import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SMTPServer } from 'smtp-server';
import { sendWrappedMails, type SmtpServer } from '../scripts/wrapped/mail.ts';
import { mergeManifest, readManifest, writeManifest, type WrappedCard } from '../scripts/wrapped/manifest.ts';

type Received = { to: string[]; raw: string };

/** A local SMTP server that takes the password "app-wachtwoord" and refuses mail once `quota` is used up. */
async function fakeGmail(quota = Infinity) {
  const received: Received[] = [];
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.password === 'app-wachtwoord') callback(null, { user: auth.username });
      else callback(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
    },
    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      stream.on('end', () => {
        if (received.length >= quota) {
          callback(Object.assign(new Error('Daily user sending quota exceeded'), { responseCode: 550 }));
          return;
        }
        received.push({ to: session.envelope.rcptTo.map((rcpt) => rcpt.address), raw });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as { port: number }).port;
  const smtp: SmtpServer = { host: '127.0.0.1', port, secure: false };
  return { received, smtp, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const card = (id: string, email: string, extra: Partial<WrappedCard> = {}): WrappedCard => ({
  runnerId: id,
  runnerNumber: id,
  name: `Loper ${id}`,
  email,
  emailValid: email.includes('@'),
  refusedContact: false,
  fileName: `${id}.png`,
  ...extra,
});

async function folderWithCards(cards: WrappedCard[]) {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'apolloon-wrapped-'));
  for (const each of cards) await fs.promises.writeFile(path.join(folder, each.fileName), `png of ${each.runnerId}`);
  await writeManifest(folder, mergeManifest(null, cards, Date.now()));
  return folder;
}

const input = (folder: string, extra: Partial<Parameters<typeof sendWrappedMails>[0]> = {}) => ({
  folder,
  from: 'apolloon@example.be',
  password: 'app-wachtwoord',
  subject: 'Jouw 24 Urenloop',
  text: 'Dank je om mee te lopen!\n\nDeel je kaart op Instagram.',
  testOnly: false,
  ...extra,
});

test('each runner gets their own card inline, and nobody without a real address or with a "no"', async () => {
  const mail = await fakeGmail();
  const folder = await folderWithCards([
    card('1', 'een@example.be'),
    card('2', '///'),
    card('3', 'drie@example.be', { refusedContact: true }),
    card('4', 'vier@example.be'),
  ]);
  try {
    const result = await sendWrappedMails(input(folder), { server: mail.smtp, delayMs: 0 });
    assert.deepEqual(result, { sent: 2, left: 0, failed: [], stopped: null });
    assert.deepEqual(
      mail.received.map((each) => each.to),
      [['een@example.be'], ['vier@example.be']]
    );
    const raw = mail.received[0].raw.replace(/=\r\n/g, '');
    assert.match(raw, /Content-ID: <wrapped-card>/);
    assert.match(raw, /Content-ID: <apolloon-logo>/);
    assert.match(raw, /In je Instagram-story/);
    assert.match(raw, /src=3D"cid:wrapped-card"/);
    // Also as a plain attachment, so it saves to a phone in one tap.
    assert.match(raw, /Content-Disposition: attachment; filename=1\.png/);
    const manifest = await readManifest(folder);
    assert.deepEqual(
      manifest?.cards.map((each) => each.sentAt != null),
      [true, false, false, true]
    );
  } finally {
    await mail.close();
  }
});

test('after a stop, sending again only reaches the runners still left', async () => {
  const limited = await fakeGmail(1);
  const folder = await folderWithCards([
    card('1', 'een@example.be'),
    card('2', 'twee@example.be'),
    card('3', 'drie@example.be'),
  ]);
  try {
    const first = await sendWrappedMails(input(folder), { server: limited.smtp, delayMs: 0 });
    assert.equal(first.sent, 1);
    assert.equal(first.left, 2);
    assert.match(first.stopped ?? '', /Gmail laat vandaag geen mails meer door/);
  } finally {
    await limited.close();
  }
  const next = await fakeGmail();
  try {
    const second = await sendWrappedMails(input(folder), { server: next.smtp, delayMs: 0 });
    assert.deepEqual(second, { sent: 2, left: 0, failed: [], stopped: null });
    assert.deepEqual(
      next.received.map((each) => each.to[0]),
      ['twee@example.be', 'drie@example.be']
    );
    // Making one card again keeps who was mailed, and the other cards.
    const remade = mergeManifest(await readManifest(folder), [card('1', 'een@example.be')], Date.now());
    assert.equal(remade.cards.length, 3);
    assert.ok(remade.cards.every((each) => each.sentAt != null));
  } finally {
    await next.close();
  }
});

test('a wrong password stops at once with a clear message', async () => {
  const mail = await fakeGmail();
  const folder = await folderWithCards([card('1', 'een@example.be'), card('2', 'twee@example.be')]);
  try {
    const result = await sendWrappedMails(input(folder, { password: 'gewoon-wachtwoord' }), {
      server: mail.smtp,
      delayMs: 0,
    });
    assert.equal(result.sent, 0);
    assert.equal(result.left, 2);
    assert.match(result.stopped ?? '', /app-wachtwoord/);
    assert.equal(mail.received.length, 0);
  } finally {
    await mail.close();
  }
});

test('the test mail goes to the sender and marks nobody as mailed', async () => {
  const mail = await fakeGmail();
  const folder = await folderWithCards([card('1', 'een@example.be')]);
  try {
    const result = await sendWrappedMails(input(folder, { testOnly: true }), { server: mail.smtp, delayMs: 0 });
    assert.equal(result.sent, 1);
    assert.deepEqual(mail.received[0].to, ['apolloon@example.be']);
    assert.equal((await readManifest(folder))?.cards[0].sentAt, null);
  } finally {
    await mail.close();
  }
});
