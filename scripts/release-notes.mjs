import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INSTALL = `### Downloads

The builds below are not signed by Apple or Microsoft yet.

- **macOS (Apple silicon)**: unzip, move \`Agentic Crafting Table.app\` to Applications, then run
  \`xattr -dr com.apple.quarantine "/Applications/Agentic Crafting Table.app"\` once so macOS opens it.
- **Windows (x64)**: unzip and run \`Agentic Crafting Table\\Contents\\agentic-crafting-table.exe\`; SmartScreen asks once,
  choose More info → Run anyway.
- **Linux (x64)**: extract and run \`Agentic Crafting Table/Contents/agentic-crafting-table\`.

A downloaded app shows newer releases in Settings → General with a link to download them. From a checkout,
\`npm run update\` builds and installs the newest release in place.
`;

/** The GitHub release notes for `version`: its CHANGELOG section, then how to open the downloads. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n'), start = lines.findIndex(line => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) throw new Error(`The changelog has no section for ${version}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!section) throw new Error(`The changelog has no entries for ${version}`);
  return `${section}\n\n${INSTALL}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]?.replace(/^v/, '');
  if (!version) throw new Error('Usage: node scripts/release-notes.mjs <version>');
  process.stdout.write(releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version));
}
