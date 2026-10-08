import { useAppActions } from '../../app/index';
import type { NearbyGroup } from '../../types';
import { useConfirm } from '../ConfirmDialog';
import { useAdminAction } from './AdminNotice';

/**
 * Koppelen: links this laptop with another one, after saying which laptop takes whose data.
 * The laptop with fewer runners always takes the other's (the server decides; `found.link`
 * says which way for a laptop from the list). Used by Beheer › Systeem and by the welcome
 * screen of a laptop that is still empty.
 */
export function useJoinGroup(runnerCount: number) {
  const confirm = useConfirm();
  const { joinGroup } = useAppActions();
  const { pending, notice, run } = useAdminAction();

  async function join(url: string, found?: NearbyGroup) {
    if (!url || pending) return null;
    const own =
      runnerCount === 0
        ? 'Op deze laptop staat nog niets, dus er gaat niets verloren.'
        : `Wat nu op deze laptop staat (${countLabel(runnerCount, 'loper', 'lopers')}), wordt eerst als backup bewaard.`;
    const confirmed = await confirm(
      found?.link === 'invite'
        ? {
            title: 'Laptops koppelen?',
            message: `Op ${shortUrl(found.url)} staan nog geen lopers. ${found.laptops > 1 ? 'Die laptops nemen' : 'Die laptop neemt'} alle gegevens van deze laptop over en ${found.laptops > 1 ? 'werken' : 'werkt'} daarna mee. Op deze laptop verandert niets.`,
            confirmLabel: 'Koppelen',
          }
        : {
            title: 'Deze laptop koppelen?',
            message: found
              ? `Deze laptop neemt alle gegevens van ${shortUrl(found.url)} (${countLabel(found.runners, 'loper', 'lopers')}) over en werkt daarna mee. ${own}`
              : `De laptop met de minste lopers neemt alle gegevens van de andere over en werkt daarna mee. Wat daar stond, wordt eerst als backup bewaard.`,
            confirmLabel: 'Koppelen',
            tone: runnerCount === 0 ? 'default' : 'danger',
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

export function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
