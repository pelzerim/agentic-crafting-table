#!/usr/bin/env node
/** node scripts/build.mjs [--out <directory>]
 * Bundles the three entries and the stylesheet into <directory>/dist (default: this package),
 * copies act-plugin.json next to it, and leaves a folder that Load from folder accepts.
 * SDK helpers are bundled in; the host is reached only through ServiceHost/RendererHost. */
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const flag = process.argv.indexOf('--out'), out = flag > 0 ? resolve(process.argv[flag + 1]) : root, dist = join(out, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const shared = { bundle: true, format: 'esm', legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
/** The definitions entry also runs in the window and the MCP bridge: refuse Node built-ins. */
const neutral = {
  name: 'neutral',
  setup(context) {
    context.onResolve({ filter: /^node:/ }, args => ({ errors: [{ text: `definitions must stay platform-neutral; ${args.importer} imports ${args.path}` }] }));
  },
};
await Promise.all([
  build({ ...shared, entryPoints: ['src/plugin.ts'], outfile: join(dist, 'definitions.mjs'), platform: 'neutral', mainFields: ['module', 'main'], plugins: [neutral] }),
  build({ ...shared, entryPoints: ['src/service.ts'], outfile: join(dist, 'service.mjs'), platform: 'node', target: 'node22' }),
  build({ ...shared, entryPoints: ['src/renderer.ts'], outfile: join(dist, 'renderer.mjs'), platform: 'browser' }),
  copyFile(join(root, 'src/styles.css'), join(dist, 'renderer.css')),
]);
if (out !== root) await copyFile(join(root, 'act-plugin.json'), join(out, 'act-plugin.json'));
console.log(`Built ${dist}: definitions.mjs, service.mjs, renderer.mjs, renderer.css.`);
