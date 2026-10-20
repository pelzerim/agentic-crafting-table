import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.filter(entry => entry.name !== 'node_modules').map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findTests(path) : entry.name.endsWith('.test.ts') ? [path] : [];
  }));
  return nested.flat();
}
const files = (await Promise.all(['src', 'packages', 'apps/desktop', 'scripts', 'examples'].map(findTests))).flat().sort();
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
