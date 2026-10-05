import { useAppActions } from '../../app/index';
import type { NearbyGroup } from '../../types';
import { useConfirm } from '../ConfirmDialog';
import { useAdminAction } from './AdminNotice';

/**
 * Links this laptop to another one's group, after saying what happens to its own data.
 * Used by Beheer › Systeem and by the welcome screen of a laptop that is still empty.
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
    const confirmed = await confirm({
      title: 'Deze laptop koppelen?',
      message: `Deze laptop neemt alle gegevens van ${found ? `${shortUrl(found.url)} (${countLabel(found.runners, 'loper', 'lopers')})` : 'de andere laptops'} over en werkt daarna mee. ${own}`,
      confirmLabel: 'Koppelen',
      tone: runnerCount === 0 ? 'default' : 'danger',
    });
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
