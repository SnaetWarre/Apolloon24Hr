import { useAppActions } from '../../app/index';
import type { NearbyGroup } from '../../types';
import { useConfirm } from '../ConfirmDialog';
import { useAdminAction } from './AdminNotice';

/**
 * Koppelen: links this laptop with another one, after saying which laptop takes whose data.
 * The laptop with fewer runners always takes the other's, and with as many, a laptop nobody
 * changed yet (`changed`) takes the data of one that someone prepared (the server decides;
 * `found.link` says which way for a laptop from the list). Used by Beheer › Systeem and by
 * the welcome screen of a laptop that is still empty.
 */
export function useJoinGroup(runnerCount: number, changed: boolean) {
  const confirm = useConfirm();
  const { joinGroup } = useAppActions();
  const { pending, notice, run } = useAdminAction();

  async function join(url: string, found?: NearbyGroup) {
    if (!url || pending) return null;
    const own =
      runnerCount > 0
        ? `Wat nu op deze laptop staat (${countLabel(runnerCount, 'loper', 'lopers')}), wordt eerst als backup bewaard.`
        : changed
          ? 'Wat al op deze laptop is ingesteld, wordt eerst als backup bewaard.'
          : 'Op deze laptop staat nog niets, dus er gaat niets verloren.';
    const confirmed = await confirm(
      found?.link === 'invite'
        ? {
            title: 'Laptops koppelen?',
            message: `Op ${laptopLabel(found)} staan nog geen lopers. ${found.laptops > 1 ? 'Die laptops nemen' : 'Die laptop neemt'} alle gegevens van deze laptop over en ${found.laptops > 1 ? 'werken' : 'werkt'} daarna mee. Op deze laptop verandert niets.`,
            confirmLabel: 'Koppelen',
          }
        : {
            title: 'Deze laptop koppelen?',
            message: found
              ? `Deze laptop neemt alle gegevens van ${laptopLabel(found)} (${countLabel(found.runners, 'loper', 'lopers')}) over en werkt daarna mee. ${own}`
              : `De laptop met de minste lopers neemt alle gegevens van de andere over en werkt daarna mee. Wat daar stond, wordt eerst als backup bewaard.`,
            confirmLabel: 'Koppelen',
            tone: runnerCount === 0 && !changed ? 'default' : 'danger',
          }
    );
    if (!confirmed) return null;
    return run(
      () => joinGroup(url),
      ({ backupFile }) =>
        backupFile ? `Gekoppeld. De vorige gegevens staan in de backup ${backupFile}.` : 'Gekoppeld.',
      'Koppelen mislukt'
    );
  }

  return { join, pending, notice };
}

export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** A laptop as the operator knows it: its computer name, or its address when it never told its name. */
export function laptopLabel(laptop: { name: string | null; url: string }): string {
  return laptop.name ?? shortUrl(laptop.url);
}

/** The name with the address behind it, for a message that may send someone to that laptop. */
export function laptopWithAddress(laptop: { name: string | null; url: string }): string {
  return laptop.name ? `${laptop.name} (${shortUrl(laptop.url)})` : shortUrl(laptop.url);
}

export function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
