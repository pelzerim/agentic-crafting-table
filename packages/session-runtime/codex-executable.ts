import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { findExecutable } from '../platform/shell.ts';

interface Options { platform?: NodeJS.Platform; arch?: string; home?: string; codexHome?: string; appData?: string }

const TRIPLES: Record<string, string> = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

/** npm, pnpm and Yarn put a `codex.cmd` script beside a `codex.ps1` and a `codex` shell script on PATH, each starting
 * `node …\@openai\codex\bin\codex.js`. A batch file cannot take quoted arguments safely, and Node wrapping the native
 * program adds a process, so the native `codex.exe` that the package's platform dependency carries is used instead. */
function nativeFromShim(folder: string, arch: string) {
  const triple = TRIPLES[arch];
  if (!triple) return;
  const roots = new Set([join(folder, 'node_modules', '@openai', 'codex')]);
  for (const shim of ['codex.cmd', 'codex.ps1', 'codex']) {
    let text = '';
    try { text = readFileSync(join(folder, shim), 'utf8').slice(0, 16_384); } catch { continue; }
    const relative = /(?:%~?dp0%?|\$basedir|\$PSScriptRoot)[\\/]+([^"'\s]*?node_modules[\\/]+@openai[\\/]+codex)[\\/]+bin[\\/]+codex\.js/i.exec(text)?.[1];
    if (relative) roots.add(join(folder, ...relative.split(/[\\/]+/)));
  }
  for (const root of roots) {
    let real: string;
    try { real = realpathSync(root); } catch { continue; }
    const candidates = [join(real, 'vendor', triple, 'bin', 'codex.exe')];
    // The platform package sits in the package's own node_modules (npm), or in a parent one (hoisted, pnpm).
    for (let directory = real; dirname(directory) !== directory; directory = dirname(directory))
      candidates.push(join(directory, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'));
    const found = candidates.find(isFile);
    if (found) return found;
  }
}

/** A Microsoft Store app alias is an empty reparse point that `stat` cannot follow, yet starts like a program. */
function appAlias(searchPath: string) {
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const path = join(directory, 'codex.exe');
    try { if (!lstatSync(path).isDirectory()) return path; } catch { /* not here */ }
  }
}

/** Where Codex is: a native program on PATH or in its own installer's folders, else the native program behind an
 * npm, pnpm or Yarn script on Windows, where only `.cmd`, `.ps1` and shell scripts are put on PATH. */
export function findCodexExecutable(searchPath: string, options: Options = {}) {
  const platform = options.platform ?? process.platform, home = options.home ?? homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  // The standalone installer keeps every release under CODEX_HOME and links the current one from ~/.local/bin.
  const fallbacks = [join(home, '.local', 'bin'), join(codexHome, 'packages', 'standalone', 'current', 'bin')];
  const found = findExecutable('codex', searchPath, fallbacks, platform);
  if (found || platform !== 'win32') return found;
  const appData = options.appData ?? process.env.APPDATA;
  const folders = [...new Set([...searchPath.split(delimiter).filter(Boolean), ...(appData ? [join(appData, 'npm')] : [])])];
  for (const folder of folders) {
    if (!['codex', 'codex.cmd', 'codex.ps1'].some(name => isFile(join(folder, name)))) continue;
    const native = nativeFromShim(folder, options.arch ?? process.arch);
    if (native) return native;
  }
  return appAlias(searchPath);
}
