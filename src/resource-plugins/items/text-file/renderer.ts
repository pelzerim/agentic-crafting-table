import type { RendererModule } from '../../../../packages/plugin-sdk/host.ts';
import { textFile } from './definition.ts';
import { textFileViews } from './views.ts';

const renderer: RendererModule = { activate(host) { host.views(textFile.id, textFileViews); } };
export default renderer;
