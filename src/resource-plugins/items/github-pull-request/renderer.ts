import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubPullRequest } from './definition.ts';
import { githubPullRequestViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(githubPullRequest.id, githubPullRequestViews); } };
export default renderer;
