
export function SectionNavigation<SectionId extends string>({
  label,
  sections,
  activeSectionId,
  onSectionChange,
  attentionIds,
}: {
  label: string;
  sections: ReadonlyArray<{ id: SectionId; label: string }>;
  activeSectionId: SectionId;
  onSectionChange: (sectionId: SectionId) => void;
  attentionIds?: ReadonlyArray<SectionId>;
}) {
  const attention = new Set(attentionIds ?? []);
  return (
    <nav className="section-navigation" aria-label={label}>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          aria-pressed={section.id === activeSectionId}
          onClick={() => onSectionChange(section.id)}
          className={attention.has(section.id) ? 'is-attention' : undefined}
        >
          {section.label}
          {attention.has(section.id) && (
            <span className="section-nav-dot" aria-label="Vraagt aandacht">
              !
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
