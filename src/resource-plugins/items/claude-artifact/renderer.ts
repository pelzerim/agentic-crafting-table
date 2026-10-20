import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { claudeArtifact } from './definition.ts';
import { claudeArtifactViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(claudeArtifact.id, claudeArtifactViews); } };
export default renderer;
