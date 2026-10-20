import type { PluginDefinitionsModule } from '../../../../packages/plugin-sdk/host.ts';
import { notionPage } from './definition.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [notionPage],
  runtimeOperations: [{ id: 'notion.page.comments', description: 'How many comments on a Notion page are unread here (local state; read-only).' }],
  settings: { typeId: notionPage.id, label: 'Comments', description: 'Comments by the connected integration never count as unread. Add your own Notion user ID so the comments you write in Notion don’t either.',
    fields: { myUserIds: { label: 'Your Notion user ID', kind: 'text', default: '', pattern: '^[A-Fa-f0-9 ,-]*$', description: 'One or more IDs, separated by commas. Leave empty to count every comment by a person.' } } },
};
export default plugin;
