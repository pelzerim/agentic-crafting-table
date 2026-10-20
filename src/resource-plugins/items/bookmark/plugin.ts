import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { bookmark } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [bookmark] };
export default plugin;
