#!/usr/bin/env node
/** act-plugin pack [dir]: checks the manifest and writes act-plugin.integrity.json for a release.
 * act-plugin verify [dir]: checks a release against its committed integrity file. */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePluginManifest } from './manifest.ts';
import { INTEGRITY_FILE, MANIFEST_FILE, packRelease, readIntegrity, releaseFiles, verifyRelease } from './integrity.ts';

/** The manifest must parse and every entry and stylesheet it names must be a released file. */
export async function checkRelease(root: string) {
  const manifest = parsePluginManifest(JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')));
  const files = new Set(await releaseFiles(root));
  const named = [...Object.values(manifest.entries).filter((entry): entry is string => Boolean(entry)), ...manifest.contributes.css];
  const absent = named.filter(file => !files.has(file));
  if (absent.length) throw new Error(`act-plugin.json names files outside the release: ${absent.join(', ')}. Build into dist/ first.`);
  return manifest;
}

export async function main(argv: readonly string[]) {
  const [command, directory = '.'] = argv, root = resolve(directory);
  if (command === 'pack') {
    const manifest = await checkRelease(root), integrity = await packRelease(root);
    return `Wrote ${INTEGRITY_FILE} for ${manifest.id} ${manifest.version}: ${Object.keys(integrity.files).length} files. Commit it with dist/ and tag the release.`;
  }
  if (command === 'verify') {
    const manifest = await checkRelease(root);
    await verifyRelease(root, (await readIntegrity(root)).files);
    return `${manifest.id} ${manifest.version}: every released file matches ${INTEGRITY_FILE}.`;
  }
  throw new Error('Usage: act-plugin pack [dir] | act-plugin verify [dir]');
}

// Compared by real path so the tool also runs through a linked checkout.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(message => console.log(message), error => { console.error((error as Error).message); process.exitCode = 1; });
}
