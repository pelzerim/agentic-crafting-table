import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { noteItem } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [noteItem] };
export default plugin;
