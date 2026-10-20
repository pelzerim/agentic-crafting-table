import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { claudeArtifact } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [claudeArtifact] };
export default plugin;
