import { webLinkConnector } from './connector.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { webLink } from './definition.ts';

const service: ServiceModule = {
  activate(host) {
    host.connector(webLink.id, webLinkConnector);
  },
};
export default service;
