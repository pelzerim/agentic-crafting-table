import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LINUX_EXECUTABLE, bundleLayout } from '../packages/core/bundle-layout.ts';

/** The local app bundle on this machine: built by `npm run package`, installed by `npm run install:local`.
 * Node built-ins only, so the updater helper still starts after an interrupted `npm ci`. */
export const layout = bundleLayout(process.platform, process.arch);
export const stagedBundle = resolve(layout.staged), installedBundle = resolve(layout.installed);
export const executableIn = bundle => join(bundle, layout.executable);
/** Only macOS has an Info.plist, so `npm run package` writes the two fields the installer and updater read. */
export const LINUX_BUNDLE_INFO = 'Contents/bundle-info.json';

/** `{ identifier, version }` of a built bundle; throws when it has none. */
export function bundleInfo(bundle) {
  if (process.platform !== 'darwin') return JSON.parse(readFileSync(join(bundle, LINUX_BUNDLE_INFO), 'utf8'));
  const field = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  return { identifier: field('CFBundleIdentifier'), version: field('CFBundleShortVersionString') };
}

/** Executables of the person's running processes; Linux `ps` truncates `comm`, so read `/proc` instead. */
function runningExecutables() {
  if (process.platform === 'win32') return execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | ForEach-Object Path'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(path => path.trim().toLowerCase());
  if (process.platform !== 'linux') return execFileSync('/bin/ps', ['-ax', '-o', 'comm='], { encoding: 'utf8' }).split('\n').map(command => command.trim());
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try { return [readlinkSync(`/proc/${pid}/exe`)]; } catch { return []; } // Exited, or another user's process.
  });
}
export const isRunningFrom = bundles => runningExecutables().some(executable => bundles.some(bundle => executable.startsWith((process.platform === 'win32' ? bundle.toLowerCase() : bundle) + sep)));

export function openBundle(bundle) {
  if (process.platform === 'darwin') { execFileSync('/usr/bin/open', [bundle]); return; }
  spawn(executableIn(bundle), [], { detached: true, stdio: 'ignore' }).unref();
}

/** Linux launchers and act:// links find the app through a desktop entry; macOS reads both from Info.plist. */
export function registerDesktopEntry(bundle) {
  const applications = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'applications'), file = `${LINUX_EXECUTABLE}.desktop`;
  const quoted = path => `"${path.replace(/["`$\\]/g, character => '\\' + character).replaceAll('%', '%%')}"`;
  mkdirSync(applications, { recursive: true });
  writeFileSync(join(applications, file), ['[Desktop Entry]', 'Type=Application', 'Name=Agentic Crafting Table', 'Comment=A spatial workspace for coding agents and their projects',
    `Exec=${quoted(executableIn(bundle))} %U`, `Icon=${join(bundle, 'Contents/resources/app-icon.png')}`, 'Terminal=false', 'Categories=Development;',
    'MimeType=x-scheme-handler/act;', `StartupWMClass=${LINUX_EXECUTABLE}`, ''].join('\n'));
  execFileSync('xdg-mime', ['default', file, 'x-scheme-handler/act']);
  return join(applications, file);
}

/** Ubuntu 23.10 and later let only AppArmor-profiled programs create the user namespaces Chromium's sandbox needs. */
export const LINUX_SANDBOX_PROFILE = `/etc/apparmor.d/${LINUX_EXECUTABLE}`;
export const linuxSandboxRestricted = () => process.platform === 'linux' && !existsSync(LINUX_SANDBOX_PROFILE)
  && (() => { try { return readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; } catch { return false; } })();

/** Allows user namespaces for this checkout's development, staged and installed Electron only, like Ubuntu's own Chrome and VS Code profiles. */
export function linuxSandboxProfile(checkout) {
  if (/["{}[\]*?^\\]/.test(checkout)) throw new Error(`The checkout path cannot be written into an AppArmor profile: ${checkout}`);
  return `abi <abi/4.0>,
include <tunables/global>

profile ${LINUX_EXECUTABLE} "${checkout}/{node_modules/electron/dist/electron,release/{staged/,}linux-*/Agentic Crafting Table/${layout.executable}}" flags=(unconfined) {
  userns,

  include if exists <local/${LINUX_EXECUTABLE}>
}
`;
}
