// Optional local capability evidence. Reads metadata only; never starts a model turn.
import { codexModels } from '../packages/session-runtime/codex.ts';
import { openCodexMetadata } from '../packages/session-runtime/codex-client.ts';
const catalog = await codexModels();
const client = await openCodexMetadata(catalog.executable);
try {
  const sessions = await client.sessions({ limit: 1 });
  console.log(JSON.stringify({ version: catalog.version, models: catalog.models.map(model => model.model), savedSessionMetadata: true, hasSavedSessions: sessions.data.length > 0 }, null, 2));
} finally { client.rpc.close(); }
