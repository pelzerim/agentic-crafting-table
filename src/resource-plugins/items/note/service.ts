import { noteConnector } from './connector.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { noteItem } from './definition.ts';

const service: ServiceModule = {
  activate(host) {
    host.connector(noteItem.id, noteConnector);
  },
};
export default service;
