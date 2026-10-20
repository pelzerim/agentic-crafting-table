import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubReviewRun } from './definition.ts';
import { workflowReviewViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(githubReviewRun.id, workflowReviewViews); } };
export default renderer;
