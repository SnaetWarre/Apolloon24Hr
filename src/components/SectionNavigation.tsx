import React from 'react';

export function SectionNavigation<SectionId extends string>({
  label,
  sections,
  activeSectionId,
  onSectionChange,
}: {
  label: string;
  sections: ReadonlyArray<{ id: SectionId; label: string }>;
  activeSectionId: SectionId;
  onSectionChange: (sectionId: SectionId) => void;
}) {
  return (
    <nav className="section-navigation" aria-label={label}>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          aria-pressed={section.id === activeSectionId}
          onClick={() => onSectionChange(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
