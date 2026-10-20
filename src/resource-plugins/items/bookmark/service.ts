import { bookmarkConnector } from './connector.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { bookmark } from './definition.ts';

const service: ServiceModule = {
  activate(host) {
    host.connector(bookmark.id, bookmarkConnector);
  },
};
export default service;
