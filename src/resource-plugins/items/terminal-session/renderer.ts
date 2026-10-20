import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { terminalSession } from './definition.ts';
import { terminalViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(terminalSession.id, terminalViews); } };
export default renderer;
