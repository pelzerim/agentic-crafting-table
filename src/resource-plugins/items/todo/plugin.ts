import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { todoItem } from './definition.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [todoItem],
  settings: { typeId: todoItem.id, label: 'To-do list', description: 'The list sorts to-dos into Next and Later. Ticked ones fold into Done.',
    fields: {
      doneArchiveDays: { label: 'Move done to-dos to Archive after', kind: 'select', options: ['1', '3', '7', 'never'], optionLabels: { 1: '1 day', 3: '3 days', 7: '7 days', never: 'Never' }, default: '3',
        description: 'Counted from when a to-do was ticked or last changed. You can restore it from Archive.' },
    } },
};
export default plugin;
