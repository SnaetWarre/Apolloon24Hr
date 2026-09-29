import React from 'react';
import { useAppData, useClusterStatus } from '../app/index';
import { useArrivals } from '../lib/motion';
import { buildEventReadiness, readinessSummary } from '../lib/readiness';
import type { LiveAppSnapshot } from '../types';
import { LabelsSection } from './admin/LabelsSection';
import { PreparationSection } from './admin/PreparationSection';
import { PublicSection } from './admin/PublicSection';
import { RunnersSection } from './admin/RunnersSection';
import { SystemSection } from './admin/SystemSection';
import { PageHeader } from './PageHeader';
import { SectionNavigation } from './SectionNavigation';

const selectAdminData = ({ labels, runners, settings, temporaryTeams, host }: LiveAppSnapshot) => ({
  labels,
  runners,
  settings,
  temporaryTeams,
  host,
});

type AdminSection = 'preparation' | 'runners' | 'labels' | 'public' | 'system';

const ADMIN_SECTIONS: ReadonlyArray<{ id: AdminSection; label: string }> = [
  { id: 'preparation', label: 'Voorbereiding' },
  { id: 'runners', label: 'Lopers' },
  { id: 'labels', label: 'Ploegen & labels' },
  { id: 'public', label: 'Publiek' },
  { id: 'system', label: 'Systeem & herstel' },
];

export function AdminView() {
  const [activeSection, setActiveSection] = React.useState<AdminSection>('preparation');
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
        <div className={contentClass('labels')} hidden={activeSection !== 'labels'}>
          <LabelsSection labels={labels} runners={runners} temporaryTeams={temporaryTeams} />
        </div>
        <div className={contentClass('public')} hidden={activeSection !== 'public'}>
          <PublicSection publicRecordMode={settings.publicRecordMode} />
        </div>
        <div className={contentClass('system')} hidden={activeSection !== 'system'}>
          <SystemSection cluster={cluster} hostUrl={host?.url ?? ''} runners={runners} labelCount={labels.length} />
        </div>
      </div>
    </>
  );
}
