import { todoConnector } from './connector.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { todoItem } from './definition.ts';

const service: ServiceModule = {
  activate(host) {
    host.connector(todoItem.id, todoConnector);
  },
};
export default service;
