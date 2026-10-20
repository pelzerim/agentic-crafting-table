#!/usr/bin/env node
/** node scripts/act-plugin.mjs pack|verify [dir]: the SDK's release tool, resolved through node_modules. */
import { main } from '@agent-crafting-table/plugin-sdk/act-plugin.ts';

main(process.argv.slice(2)).then(message => console.log(message), error => { console.error(error.message); process.exitCode = 1; });
