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
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = React.useState(false);

  // A one-pixel marker sits right above the bar; once it scrolls out of view the bar is stuck.
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} className="page-header__sentinel" aria-hidden="true" />
      <header className={`page-header${stuck ? ' is-stuck' : ''}`}>
        <h1>{title}</h1>
        {meta && <div className="page-header__meta">{meta}</div>}
        {actions && <div className="page-header__actions">{actions}</div>}
      </header>
    </>
  );
}
