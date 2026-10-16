import fs from 'fs';
import path from 'path';

/**
 * `manifest.json` in the Wrapped folder: who has which card and who already got it by mail.
 * Written after every mail, so sending again after a stop only reaches the people still left.
 */

/** One runner's card, as `npm run wrapped:cards` writes it. */
export type WrappedCard = {
  runnerId: string;
  runnerNumber: string | null;
  name: string;
  email: string;
  emailValid: boolean;
  /** Said no to being contacted again in the form. */
  refusedContact: boolean;
  fileName: string;
};

export type WrappedManifestEntry = WrappedCard & {
  sentAt: number | null;
  /** Why the last mail to this runner failed, until one gets through. */
  error: string | null;
  /** The runner's share page, set by `npm run wrapped:publish`; a random token keeps it unguessable. */
  shareUrl?: string | null;
};

export type WrappedManifest = { madeAt: number; cards: WrappedManifestEntry[] };

export const MANIFEST_FILE = 'manifest.json';

export async function readManifest(folder: string): Promise<WrappedManifest | null> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(folder, MANIFEST_FILE), 'utf8')) as WrappedManifest;
  } catch {
    return null;
  }
}

/** Through a temporary file, so a crash halfway never leaves a broken list. */
export async function writeManifest(folder: string, manifest: WrappedManifest): Promise<void> {
  const target = path.join(folder, MANIFEST_FILE);
  const temporary = `${target}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.promises.rename(temporary, target);
}

/**
 * Adds the cards just made to the list. Making a card again keeps whether it was mailed,
 * so nobody gets a second mail, and its share link, so a link in a sent mail keeps working.
 * Cards made in an earlier run stay on the list.
 */
export function mergeManifest(previous: WrappedManifest | null, cards: WrappedCard[], madeAt: number): WrappedManifest {
  const byRunner = new Map(previous?.cards.map((card) => [card.runnerId, card]) ?? []);
  for (const card of cards) {
    const previousCard = byRunner.get(card.runnerId);
    byRunner.set(card.runnerId, {
      ...card,
      sentAt: previousCard?.sentAt ?? null,
      error: null,
      shareUrl: previousCard?.shareUrl ?? null,
    });
  }
  return { madeAt, cards: [...byRunner.values()].sort((a, b) => a.fileName.localeCompare(b.fileName, 'nl-BE')) };
}

/** Who gets a mail: a real address, no "no" to contact, and not mailed yet. */
export function mailableCards(manifest: WrappedManifest): WrappedManifestEntry[] {
  return manifest.cards.filter((card) => card.emailValid && !card.refusedContact && card.sentAt == null);
}
