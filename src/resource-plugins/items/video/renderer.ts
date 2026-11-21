import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { video } from './definition.ts';
import { videoViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(video.id, videoViews); } };
export default renderer;
