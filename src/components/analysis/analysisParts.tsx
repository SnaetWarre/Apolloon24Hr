import { useArrivals } from '../../lib/motion';

export function StatPanel({ label, value, hero }: { label: string; value: string; hero?: boolean }) {
  const hasLongValue = value.length >= 10;
  // A figure that changes with the filter lifts briefly; the first figure is simply there.
  const changed = useArrivals([value]).has(value);
  return (
    <div className={`stat-panel${hasLongValue ? ' stat-panel--long-value' : ''}${hero ? ' stat-panel--hero' : ''}`}>
      <span className="muted-label">{label}</span>
      <strong key={value} className={changed ? 'value-tick' : undefined} title={value}>
        {value}
      </strong>
    </div>
  );
}

export function SectionHeader({ title, text }: { title: string; text: string }) {
  return (
    <div className="analysis-section-header">
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

export function EmptyAnalyticsState({ message }: { message: string }) {
  return <div className="empty-analytics-state">{message}</div>;
}
