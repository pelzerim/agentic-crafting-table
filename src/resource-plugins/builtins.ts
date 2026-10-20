import type { ResourcePluginRegistry } from './registry.ts';
import { PluginPackageRegistry } from './packages.ts';
import { bundledPackages } from './bundled/packages.generated.ts';
import type { ResourcePluginDefinition } from './types.ts';
import type { PluginDefinitionsModule } from '../../packages/plugin-sdk/host.ts';

// Compatibility exports; implementations live in their own item folders.
export { agentSession } from './items/agent-session/definition.ts';
export { terminalSession } from './items/terminal-session/definition.ts';
export { githubPullRequest } from './items/github-pull-request/definition.ts';
export { claudeArtifact } from './items/claude-artifact/definition.ts';
export { codeReview } from './items/code-review/definition.ts';
export { githubReviewRun } from './items/github-review-run/definition.ts';
export { linearTicket } from './items/linear-ticket/definition.ts';
export { notionPage } from './items/notion-page/definition.ts';
export { slackMessage } from './items/slack-message/definition.ts';
export { bookmark } from './items/bookmark/definition.ts';
export { webLink } from './items/web-link/definition.ts';
export { todoItem } from './items/todo/definition.ts';
export { noteItem } from './items/note/definition.ts';

let installedPackages: readonly { manifest: unknown; module: PluginDefinitionsModule }[] = [];
/** Packages this process loaded from the plugin store. The loader has already checked that they
 * register cleanly after the bundled ones; the service and MCP bridge set this once at startup. */
export function useInstalledPackages(packages: readonly { manifest: unknown; module: PluginDefinitionsModule }[]) { installedPackages = packages; }

/** The bundled first-party packages, then installed ones, registered through the same path. */
export function createPluginPackageRegistry(): PluginPackageRegistry {
  const packages = new PluginPackageRegistry();
  for (const entry of bundledPackages) packages.register(entry);
  for (const entry of installedPackages) packages.register(entry);
  return packages;
}

export function createResourcePluginRegistry(additional: readonly ResourcePluginDefinition[] = []): ResourcePluginRegistry {
  const registry = createPluginPackageRegistry().types;
  for (const definition of additional) registry.register(definition);
  return registry;
}
