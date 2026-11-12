import { textFileConnector } from './connector.ts';
import type { ServiceModule } from '../../../../packages/plugin-sdk/host.ts';
import { textFile } from './definition.ts';

const service: ServiceModule = {
  activate(host) {
    host.connector(textFile.id, textFileConnector);
  },
};
export default service;
