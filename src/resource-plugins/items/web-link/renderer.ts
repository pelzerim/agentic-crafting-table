import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { webLink } from './definition.ts';
import { webLinkViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(webLink.id, webLinkViews); } };
export default renderer;
