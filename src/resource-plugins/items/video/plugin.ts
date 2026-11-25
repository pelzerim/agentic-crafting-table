import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { video } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [video] };
export default plugin;
