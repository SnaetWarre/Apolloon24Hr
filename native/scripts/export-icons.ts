// Reuse the application's icon geometry; do not introduce a second icon family.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Icon, type IconName } from '../../src/components/Icon';
const names: IconName[] = [
  'overview',
  'queue',
  'timing',
  'analysis',
  'tactics',
  'displayInside',
  'displayCompetitions',
  'displayOutside',
  'admin',
  'panelLeft',
];
mkdirSync(new URL('../assets/icons/', import.meta.url), { recursive: true });
for (const name of names) {
  for (const [theme, color] of [
    ['light', '#71717A'],
    ['dark', '#8B8B8B'],
    ['active', '#0D78D3'],
  ]) {
    const svg = renderToStaticMarkup(React.createElement(Icon, { name, size: 18 }))
      .replace('currentColor', color)
      .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    writeFileSync(new URL(`../assets/icons/${name}-${theme}.svg`, import.meta.url), svg);
  }
}
