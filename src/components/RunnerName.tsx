import type { Runner } from '../types';

/** Runner number as a bib (borstnummer) followed by the name. */
export function RunnerName({
  runner,
  size,
}: {
  runner: Pick<Runner, 'runnerNumber' | 'name'>;
  size?: 'lg';
}) {
  return (
    <span className={`runner-name${size ? ` runner-name--${size}` : ''}`}>
      {runner.runnerNumber && <Bib number={runner.runnerNumber} size={size} />}
      <span className="runner-name__text">{runner.name}</span>
    </span>
  );
}

export function Bib({ number, size }: { number: string; size?: 'lg' }) {
  return <span className={`bib${size ? ` bib--${size}` : ''}`}>{number}</span>;
}
