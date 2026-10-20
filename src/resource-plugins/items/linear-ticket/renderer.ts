import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { linearTicket } from './definition.ts';
import { linearTicketViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(linearTicket.id, linearTicketViews); } };
export default renderer;
