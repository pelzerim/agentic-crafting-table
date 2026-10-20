import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { codeReview } from './definition.ts';
import { codeReviewViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(codeReview.id, codeReviewViews); } };
export default renderer;
