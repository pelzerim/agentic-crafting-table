import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LINUX_SANDBOX_PROFILE, linuxSandboxProfile } from './local-bundle.mjs';

/** `npm run sandbox:linux`: write this checkout's AppArmor profile and print the root commands that load it; nothing runs as root. */
if (process.platform !== 'linux') throw new Error('Only Linux needs an AppArmor profile for the Chromium sandbox');
const profile = resolve('release/apparmor-profile');
mkdirSync(resolve('release'), { recursive: true });
writeFileSync(profile, linuxSandboxProfile(process.cwd()));
console.log(`Wrote ${profile}. Load it once with:\n\n  sudo install -m 644 '${profile}' ${LINUX_SANDBOX_PROFILE}\n  sudo apparmor_parser -r ${LINUX_SANDBOX_PROFILE}\n\nRun this again only if the checkout moves.`);
