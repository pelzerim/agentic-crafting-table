import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { bookmark } from './definition.ts';
import { bookmarkViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(bookmark.id, bookmarkViews); } };
export default renderer;
