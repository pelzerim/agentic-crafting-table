import { hiddenXtermGuard } from '../apps/desktop/xterm-render-guard.ts';
import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });
await Promise.all([
  build({ entryPoints: ['apps/desktop/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node-pty'], sourcemap: true }),
  build({ entryPoints: ['apps/desktop/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['packages/session-runtime/probe.ts'], outfile: 'dist/pty-probe.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['node-pty'], sourcemap: true }),
  build({ entryPoints: ['packages/workspace-service/entry.ts'], outfile: 'dist/workspace-service.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['node-pty', '@anthropic-ai/claude-agent-sdk'], sourcemap: true }),
  build({ entryPoints: ['packages/diagnostics/log-entry.ts'], outfile: 'dist/service-log.cjs', bundle: true, platform: 'node', format: 'cjs', sourcemap: true }),
  build({ entryPoints: ['packages/session-runtime/native-process-owner.ts'], outfile: 'dist/native-process-owner.cjs', bundle: true, platform: 'node', format: 'cjs', sourcemap: true }),
  build({ entryPoints: ['packages/session-runtime/entry.ts'], outfile: 'dist/session-supervisor.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['node-pty'], sourcemap: true }),
  build({ entryPoints: ['packages/mcp/entry.ts'], outfile: 'dist/mcp-bridge.cjs', bundle: true, platform: 'node', format: 'cjs', sourcemap: true }),
  build({ entryPoints: ['packages/session-runtime/agent-hook.ts'], outfile: 'dist/agent-hook.cjs', bundle: true, platform: 'node', format: 'cjs', sourcemap: true }),
  build({ entryPoints: ['apps/desktop/renderer/app.tsx'], outfile: 'dist/renderer/app.js', plugins: [hiddenXtermGuard], bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', sourcemap: true, define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production') } }),
  copyFile('apps/desktop/renderer/index.html', 'dist/renderer/index.html'),
  copyFile('apps/desktop/assets/app-icon.png', 'dist/app-icon.png'),
]);
console.log('Built desktop main, isolated preload, and renderer.');
