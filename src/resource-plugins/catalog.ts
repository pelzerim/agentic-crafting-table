import { bundledPackages } from './bundled/packages.generated.ts';

/** Item definitions of the bundled packages, in bundled order. Shared/browser safe. */
export const itemDefinitions = bundledPackages.flatMap(entry => entry.module.definitions ?? []);
