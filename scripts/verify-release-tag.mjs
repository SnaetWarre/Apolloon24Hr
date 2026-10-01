import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyReleaseTag(tag, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) || tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} must match package.json version v${version}`);
  }
}

// Node loads the script from its real path, so a symlinked folder (macOS /var) must be resolved too.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  verifyReleaseTag(process.env.RELEASE_TAG, version);
  console.log(`Verified release v${version}`);
}
