import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { agentSession } from './definition.ts';
import { agentViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(agentSession.id, agentViews); } };
export default renderer;
