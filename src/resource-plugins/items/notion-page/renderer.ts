import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { notionPage } from './definition.ts';
import { notionPageViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(notionPage.id, notionPageViews); } };
export default renderer;
