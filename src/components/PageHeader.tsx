import React from 'react';

/** Thin, sticky page bar: title and context on the left, page actions on the right. */
export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {meta && <div className="page-header__meta">{meta}</div>}
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
