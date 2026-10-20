import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { INTEGRITY_FILE, IntegrityError, packRelease, parseIntegrity, readIntegrity, releaseFiles, verifyRelease } from './integrity.ts';
import { checkRelease, main } from './act-plugin.ts';

const manifest = { id: 'acme', name: 'Acme', version: '1.0.0', apiRange: '^1.0.0', entries: { definitions: 'dist/definitions.mjs', renderer: 'dist/renderer.mjs' }, contributes: { css: ['dist/renderer.css'] } };

async function release(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'act-release-'));
  try {
    await mkdir(join(root, 'dist/chunks'), { recursive: true });
    await writeFile(join(root, 'act-plugin.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'dist/definitions.mjs'), 'export default { definitions: [] };\n');
    await writeFile(join(root, 'dist/renderer.mjs'), 'export default { activate() {} };\n');
    await writeFile(join(root, 'dist/renderer.css'), '.acme { color: var(--ink); }\n');
    await writeFile(join(root, 'dist/chunks/shared.mjs'), 'export const shared = 1;\n');
    await mkdir(join(root, 'src')); await writeFile(join(root, 'src/ignored.ts'), 'source is not released');
    await work(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('pack lists the manifest and every dist file with its sha256, and verify accepts it', () => release(async root => {
  const message = await main(['pack', root]);
  assert.match(message, /acme 1\.0\.0: 5 files/);
  const written = JSON.parse(await readFile(join(root, INTEGRITY_FILE), 'utf8'));
  assert.deepEqual(Object.keys(written.files), ['act-plugin.json', 'dist/chunks/shared.mjs', 'dist/definitions.mjs', 'dist/renderer.css', 'dist/renderer.mjs']);
  assert.match(written.files['dist/renderer.mjs'], /^[0-9a-f]{64}$/);
  await verifyRelease(root, (await readIntegrity(root)).files);
  assert.match(await main(['verify', root]), /every released file matches/);
}));

test('a changed, missing or extra file is refused', () => release(async root => {
  const { files } = await packRelease(root);
  await writeFile(join(root, 'dist/renderer.mjs'), 'export default { activate() { steal(); } };\n');
  await assert.rejects(verifyRelease(root, files), /changed: dist\/renderer\.mjs/);
  await writeFile(join(root, 'dist/renderer.mjs'), 'export default { activate() {} };\n');
  await verifyRelease(root, files);
  await writeFile(join(root, 'dist/extra.mjs'), '1');
  await assert.rejects(verifyRelease(root, files), /not listed: dist\/extra\.mjs/);
  await rm(join(root, 'dist/extra.mjs')); await rm(join(root, 'dist/chunks/shared.mjs'));
  await assert.rejects(verifyRelease(root, files), /missing: dist\/chunks\/shared\.mjs/);
}));

test('releases refuse symbolic links and integrity files with unsafe paths', () => release(async root => {
  await symlink('/etc/hosts', join(root, 'dist/hosts'));
  await assert.rejects(releaseFiles(root), IntegrityError);
  assert.throws(() => parseIntegrity({ algorithm: 'sha256', files: { 'act-plugin.json': 'a'.repeat(64), 'dist/../secret': 'b'.repeat(64) } }), /unsupported path/);
  assert.throws(() => parseIntegrity({ algorithm: 'sha256', files: { '/etc/hosts': 'a'.repeat(64), 'act-plugin.json': 'a'.repeat(64) } }), /unsupported path/);
  assert.throws(() => parseIntegrity({ algorithm: 'md5', files: {} }), /sha256/);
  assert.throws(() => parseIntegrity({ algorithm: 'sha256', files: { 'dist/a.mjs': 'a'.repeat(64) } }), /must cover act-plugin\.json/);
}));

test('pack refuses a manifest naming files outside dist or an incompatible API', () => release(async root => {
  await writeFile(join(root, 'act-plugin.json'), JSON.stringify({ ...manifest, entries: { definitions: 'src/plugin.ts' } }));
  await assert.rejects(checkRelease(root), /names files outside the release: src\/plugin\.ts/);
  await writeFile(join(root, 'act-plugin.json'), JSON.stringify({ ...manifest, apiRange: '^2.0.0' }));
  await assert.rejects(checkRelease(root), /needs plugin API \^2\.0\.0/);
  await assert.rejects(readIntegrity(root), /Run act-plugin pack/);
}));

test('act-plugin runs when invoked through a linked SDK folder', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'act-linked-sdk-'));
  try {
    await symlink(import.meta.dirname, join(folder, 'sdk'));
    const run = spawnSync(process.execPath, [join(folder, 'sdk/act-plugin.ts')], { encoding: 'utf8' });
    assert.equal(run.status, 1); assert.match(run.stderr, /Usage: act-plugin pack/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
