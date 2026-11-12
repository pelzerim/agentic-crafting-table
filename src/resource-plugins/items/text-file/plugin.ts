import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { textFile } from './definition.ts';
import { textFileSettingFields } from './settings.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [textFile],
  settings: { typeId: textFile.id, label: 'Saving', fields: textFileSettingFields },
};
export default plugin;
