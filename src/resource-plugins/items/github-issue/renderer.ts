import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { githubIssue } from './definition.ts';
import { githubIssueViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(githubIssue.id, githubIssueViews); } };
export default renderer;
