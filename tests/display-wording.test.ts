import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const denied =
  /\b(?:slow(?:er|est)?|traag(?:ste)?|trage|trager|langza(?:am|mer|amste)|worst|slecht(?:ste)?|verliesmomenten|underperform(?:ing)?|below[ -]average|below expectations|slower than expected|behind schedule|achter op schema|onder gemiddeld|onder de verwachting)\b/i;
const diagnostics = [
  '{} van {} laptops bevestigd · traagste {} erbij, {} weg{}',
  'Een trage of volle schijf, of een virusscanner die de databank controleert, kan dit vertragen.',
];

function violations(source: string, code = false): string[] {
  const production = source.split('#[cfg(test)]')[0];
  return production.split('\n').flatMap((line, index) => {
    const uncommented = line.replace(/\/\/.*$/, '');
    const text = code
      ? (uncommented.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g) ?? []).join(' ')
      : uncommented;
    const allowed = diagnostics.reduce((value, diagnostic) => value.replace(diagnostic, ''), text);
    return denied.test(allowed) ? [`${index + 1}: ${line.trim()}`] : [];
  });
}

function scan(directory: string): string[] {
  return fs.readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return scan(`${relative}/`);
    if (!/\.(?:rs|rune|rn|ts|js|mjs|html|css|svg)$/.test(entry.name)) return [];
    return violations(
      fs.readFileSync(new URL(relative, root), 'utf8'),
      /\.(?:rs|rune|rn|ts|js|mjs)$/.test(entry.name)
    ).map((violation) => `${relative}:${violation}`);
  });
}

test('screens, exports and Wrapped keep performance wording neutral or positive', () => {
  const failures = ['native/src/', 'native/web/', 'native/assets/', 'scripts/wrapped/', 'public/'].flatMap(scan);
  assert.deepEqual(failures, []);
});

test('wording guard catches Dutch and English labels and CSS tags', () => {
  for (const text of [
    'Trage ronde',
    'Traagste',
    'langzamer',
    'slow-lap',
    'slower than expected',
    'worst',
    'slechtste',
    'below average',
    'achter op schema',
    'Zoek de verliesmomenten',
  ]) {
    assert.equal(violations(`text("${text}")`).length, 1, text);
  }
  assert.deepEqual(violations(''), []);
  assert.deepEqual(violations('Snelste ronde · Persoonlijk record · +4 s · Maximumtijd'), []);
  assert.deepEqual(violations('// slower animation\n#[cfg(test)]\n"slow"'), []);
  assert.equal(violations(`"${diagnostics[0]}"`).length, 0);
  assert.equal(violations(`"${diagnostics[0]} slow lap"`).length, 1);
  assert.deepEqual(violations('let slowest = value;', true), []);
  assert.equal(violations('text("slow lap")', true).length, 1);
});
