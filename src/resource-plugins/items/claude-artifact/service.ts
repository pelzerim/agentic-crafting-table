import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { claudeArtifactConnector } from './connector.ts';
import { claudeArtifact } from './definition.ts';

const service: ServiceModule = { activate(host) { host.connector(claudeArtifact.id, claudeArtifactConnector); } };
export default service;
