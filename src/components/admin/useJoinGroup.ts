import { useAppActions } from '../../app/index';
import type { ClusterStatus, NearbyGroup } from '../../types';
import { useConfirm } from '../ConfirmDialog';
import { useAdminAction } from './useAdminAction';

/**
 * Koppelen: links this laptop's group with another one, after saying what happens to whose data
 * (the server decides; `found.link` says which way for a laptop from the list). Before the race
 * (it started on neither side; a test of fewer than ten laps does not count), the side that takes
 * the other's data brings its runners and labels along. Once it started, a laptop where the race
 * does not run takes the data of one where it runs (started, not finished), and then a laptop
 * where it has not started takes the data of one where it has; otherwise the laptop with fewer
 * runners. Used by Beheer › Systeem and by the welcome screen of a laptop that is still empty.
 */
export function useJoinGroup(
  own: Pick<ClusterStatus, 'runners' | 'changed' | 'raceStarted' | 'raceRunning' | 'members'>
) {
  const confirm = useConfirm();
  const { joinGroup } = useAppActions();
  const { pending, run } = useAdminAction();

  async function join(url: string, found?: NearbyGroup) {
    if (!url || pending) return null;
    const merging = found ? !found.raceStarted && !own.raceStarted : false;
    const others = own.members.length - 1;
    const kept =
      own.runners > 0
        ? `Wat nu op deze laptop staat (${countLabel(own.runners, 'loper', 'lopers')}), wordt eerst als backup bewaard.`
        : own.changed
          ? 'Wat al op deze laptop is ingesteld, wordt eerst als backup bewaard.'
          : 'Op deze laptop staat nog niets, dus er gaat niets verloren.';
    const raceThere =
      found?.raceRunning && !own.raceRunning
        ? `Op ${laptopLabel(found)} loopt de race. `
        : found?.raceStarted && !own.raceStarted
          ? `Op ${laptopLabel(found)} is de race al gestart. `
          : '';
    const follow =
      others === 0
        ? ''
        : others === 1
          ? ' De andere laptop van deze groep doet mee.'
          : ` De ${others} andere laptops van deze groep doen mee.`;
    const confirmed = await confirm(
      found?.link === 'invite'
        ? {
            title: 'Laptops koppelen?',
            message:
              merging && found.runners > 0
                ? `De ${countLabel(found.runners, 'loper', 'lopers')} en de labels van ${laptopLabel(found)} komen erbij op deze laptop. ${SAME_RUNNER} Daarna ${found.laptops > 1 ? 'nemen die laptops' : 'neemt die laptop'} de rest van deze laptop over en ${found.laptops > 1 ? 'werken' : 'werkt'} mee. Op deze laptop gaat niets verloren.`
                : `Op ${laptopLabel(found)} staan nog geen lopers. ${found.laptops > 1 ? 'Die laptops nemen' : 'Die laptop neemt'} alle gegevens van deze laptop over en ${found.laptops > 1 ? 'werken' : 'werkt'} daarna mee. Op deze laptop verandert niets.`,
            confirmLabel: 'Koppelen',
          }
        : {
            title: others > 0 ? 'Deze laptops koppelen?' : 'Deze laptop koppelen?',
            message: !found
              ? 'Is de race nog nergens gestart, dan komen de lopers en labels van beide laptops samen. Anders houdt de laptop waar de race loopt zijn gegevens, dan die waar de race al gestart is, en daarna die met de meeste lopers. De andere laptop neemt alle gegevens over en werkt daarna mee. Wat daar stond, wordt eerst als backup bewaard.'
              : merging && (own.runners > 0 || own.changed)
                ? `${own.runners > 0 ? `De ${countLabel(own.runners, 'loper', 'lopers')} en de labels` : 'De labels'} van deze laptop gaan mee naar ${laptopLabel(found)}. ${SAME_RUNNER} Voor de rest neemt deze laptop de gegevens van ${laptopLabel(found)} over, zoals logo's en instellingen, en werkt daarna mee.${follow} Wat hier nu staat, wordt eerst als backup bewaard.`
                : `${raceThere}Deze laptop neemt alle gegevens van ${laptopLabel(found)} (${countLabel(found.runners, 'loper', 'lopers')}) over en werkt daarna mee.${follow} ${kept}`,
            confirmLabel: 'Koppelen',
            tone: merging || (own.runners === 0 && !own.changed) ? 'default' : 'danger',
          }
    );
    if (!confirmed) return null;
    return run(
      () => joinGroup(url),
      ({ backupFile, merged }) =>
        merged
          ? { text: 'Gekoppeld.', detail: 'De lopers en labels van deze laptop staan nu ook in de groep.' }
          : backupFile
            ? { text: 'Gekoppeld.', detail: 'De vorige gegevens van deze laptop staan in de backup "Vóór koppelen".' }
            : 'Gekoppeld.',
      'Koppelen mislukt'
    );
  }

  return { join, pending };
}

const SAME_RUNNER = 'Wie met dezelfde naam, e-mail en telefoon op beide staat, komt er één keer in.';

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
