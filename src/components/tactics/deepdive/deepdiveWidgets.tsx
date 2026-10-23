import { useArrivals } from '../../../lib/motion';
import { NumberInput } from '../NumberInput';

export function NumberControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <div className="tactics-number-control">
        <NumberInput className="input" value={value} min={min} max={max} step={step} onChange={onChange} />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}

export function DeepStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  const changed = useArrivals([value]).has(value);
  return (
    <div className="stat-panel tactics-stat">
      <span className="muted-label">{label}</span>
      <strong key={value} className={changed ? 'value-tick' : undefined}>
        {value}
      </strong>
      <small>{detail}</small>
    </div>
  );
}

export function SectionHeader({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return (
    <div className="analysis-section-header">
      <span className="page-kicker">{kicker}</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
