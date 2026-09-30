import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The body of a GitHub release: that version's CHANGELOG section, then what anyone
 * installing it needs to know. Fails when the section is missing or empty, so a release
 * never goes out without saying what changed.
 */
export function releaseNotes(changelog, version) {
  const heading = new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\][^\\n]*$`, 'm');
  const start = heading.exec(changelog);
  if (!start) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = changelog.slice(start.index + start[0].length);
  const end = rest.search(/^## \[/m);
  const section = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (!section) throw new Error(`The CHANGELOG.md section for ${version} is empty`);
  return `${section}

## Installeren

- **Windows**: \`.exe\`. Windows waarschuwt omdat het installatieprogramma niet ondertekend is: kies *Meer informatie* › *Toch uitvoeren*.
- **Linux**: \`.AppImage\`. Maak het uitvoerbaar (\`chmod +x\`) en start het.
- **macOS (Apple Silicon)**: \`.dmg\`. Niet ondertekend: open de app één keer, kies dan in *Systeeminstellingen* › *Privacy en beveiliging* voor *Toch openen*.

Zet op alle laptops dezelfde versie. Controleer een download met \`SHA256SUMS.txt\`
(\`sha256sum -c SHA256SUMS.txt --ignore-missing\`, of \`Get-FileHash\` op Windows).
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  process.stdout.write(releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version));
}
