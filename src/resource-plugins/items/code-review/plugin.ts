import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { codeReview } from './definition.ts';

const plugin: PluginDefinitionsModule = { definitions: [codeReview] };
export default plugin;
