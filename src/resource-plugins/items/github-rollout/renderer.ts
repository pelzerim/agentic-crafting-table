import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubRollout } from './definition.ts';
import { githubRolloutViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(githubRollout.id, githubRolloutViews); } };
export default renderer;
