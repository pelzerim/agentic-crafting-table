import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { videoConnector } from './connector.ts';
import { video } from './definition.ts';

const service: ServiceModule = { activate(host) { host.connector(video.id, videoConnector); } };
export default service;
