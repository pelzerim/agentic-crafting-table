import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { slackMessage } from './definition.ts';
import { slackMessageViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(slackMessage.id, slackMessageViews); } };
export default renderer;
