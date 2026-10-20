/** Window entry (browser): registers the detail view. Never import service code here. */
import type { RendererModule } from '@agent-crafting-table/plugin-sdk/index.ts';
import { TYPE_ID } from './definition.ts';
import { readingLinkViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(TYPE_ID, readingLinkViews); } };
export default renderer;
