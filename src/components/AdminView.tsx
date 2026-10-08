import { useRouter, useRouterState } from '@tanstack/react-router';
import { useAppData, useClusterStatus } from '../app/index';
import { useArrivals } from '../lib/motion';
import { buildEventReadiness, readinessSummary } from '../lib/readiness';
import type { LiveAppSnapshot } from '../types';
import { ActivitySection } from './admin/ActivitySection';
import { LabelsSection } from './admin/LabelsSection';
import { LapsSection } from './admin/LapsSection';
import { PreparationSection } from './admin/PreparationSection';
import { PublicSection } from './admin/PublicSection';
import { RunnersSection } from './admin/RunnersSection';
import { SystemSection } from './admin/SystemSection';
import { ADMIN_SECTIONS, isAdminSection, type AdminSection } from './adminSections';
import { PageHeader } from './PageHeader';
import { SectionNavigation } from './SectionNavigation';

const selectAdminData = ({ labels, runners, settings, temporaryTeams, host }: LiveAppSnapshot) => ({
  labels,
  runners,
  settings,
  temporaryTeams,
  host,
});

export function AdminView() {
  // The tab is in the address (?section=system), so links can open Beheer on a given tab.
  // useRouterState and useRouter rather than useSearch and useNavigate: those split the first download.
  const requested = useRouterState({ select: (state) => state.location.search.section });
  const activeSection: AdminSection = isAdminSection(requested) ? requested : 'preparation';
  const router = useRouter();
  const setActiveSection = (section: AdminSection) =>
    void router.navigate({ to: '/admin', search: { section }, replace: true });
  const { labels, runners, settings, temporaryTeams, host } = useAppData(selectAdminData);
  const { cluster, error: clusterError } = useClusterStatus();
  const needsAttention = readinessSummary(buildEventReadiness(cluster)) !== 'ready';
  // A section chosen after the page opened rises in; the first one is simply there.
  const sectionChanged = useArrivals([`section:${activeSection}`]).has(`section:${activeSection}`);
  const contentClass = (section: AdminSection) =>
    `management-content${activeSection === section && sectionChanged ? ' rise-in' : ''}`;

  // Sections stay mounted while hidden, so switching tabs keeps unsaved input.
  return (
    <>
      <PageHeader title="Beheer" />

      <div className="management-workspace">
        <aside className="management-navigation">
          <SectionNavigation
            label="Beheeronderdelen"
            sections={ADMIN_SECTIONS}
            activeSectionId={activeSection}
            onSectionChange={setActiveSection}
            attentionIds={needsAttention ? ['system'] : []}
          />
        </aside>
        <div className={contentClass('preparation')} hidden={activeSection !== 'preparation'}>
          <PreparationSection
            cluster={cluster}
            clusterError={clusterError}
            onOpenSystem={() => setActiveSection('system')}
          />
        </div>
        <div className={contentClass('runners')} hidden={activeSection !== 'runners'}>
          <RunnersSection runners={runners} />
        </div>
        <div className={contentClass('laps')} hidden={activeSection !== 'laps'}>
          <LapsSection active={activeSection === 'laps'} />
        </div>
        <div className={contentClass('labels')} hidden={activeSection !== 'labels'}>
          <LabelsSection labels={labels} runners={runners} temporaryTeams={temporaryTeams} />
        </div>
        <div className={contentClass('public')} hidden={activeSection !== 'public'}>
          <PublicSection publicRecordMode={settings.publicRecordMode} />
        </div>
        <div className={contentClass('activity')} hidden={activeSection !== 'activity'}>
          <ActivitySection active={activeSection === 'activity'} />
        </div>
        <div className={contentClass('system')} hidden={activeSection !== 'system'}>
          <SystemSection cluster={cluster} hostUrl={host?.url ?? ''} runners={runners} labelCount={labels.length} />
        </div>
      </div>
    </>
  );
}
