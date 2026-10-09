import React from 'react';
import { clamp } from './tacticsFormat';

// Keeps the text being typed and only corrects it to min..max on blur or Enter, so typing 60 into a field
// with min 10 does not turn the first 6 into 10. Values already in range apply while typing.
export function NumberInput({
  value,
  min,
  max = Infinity,
  onChange,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'value' | 'min' | 'max' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(Number(draft))) return;
    const corrected = clamp(Number(draft), min, max);
    if (corrected !== value) onChange(corrected);
  };

  return (
    <input
      {...props}
      type="number"
      min={min}
      max={Number.isFinite(max) ? max : undefined}
      value={draft ?? value}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const typed = Number(text);
        if (text.trim() !== '' && typed >= min && typed <= max) onChange(typed);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}
