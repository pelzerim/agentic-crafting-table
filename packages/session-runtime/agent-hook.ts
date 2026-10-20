import { connectWorkspace } from '../workspace-service/client.ts';
import { hookFields, localArtifactTitle } from './agent-hook-event.ts';

async function main() {
  const observedAt = Date.now();
  const [directory, nodeId, processSessionId, nativeSessionId] = process.argv.slice(2);
  if (!directory || !nodeId || !processSessionId || !nativeSessionId) throw new Error('Missing hook binding');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 1024 * 1024) return; chunks.push(chunk); }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8')), fields = hookFields(event, nativeSessionId);
  if (!fields) return;
  // The page's own <title> names an untitled artifact; its path never leaves this process.
  const { artifact, ...observed } = fields;
  const title = artifact && (artifact.title ?? (artifact.filePath ? localArtifactTitle(artifact.filePath) : undefined));
  const published = artifact && { url: artifact.url, ...(title ? { title } : {}) };
  const client = await connectWorkspace(directory);
  try {
    const result = await client.call<{ context?: Record<string, unknown> }>('agent.hook', { nodeId, processSessionId, nativeSessionId, observedAt, ...observed, ...(published ? { artifact: published } : {}) });
    if (result.context) {
      const { guide, guideRequestId, guideRequested, ...reference } = result.context;
      const instructions = guideRequested && guide && typeof guide === 'object' && 'prompt' in guide ? String(guide.prompt) : '';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name,
        additionalContext: [instructions, `Agentic Crafting Table context offer. Read ${guideRequested ? 'the workbench guide above and ' : ''}this reference material and acknowledge its deliveryId with workspace_run action agent.context.ack.\n${JSON.stringify(reference)}`].filter(Boolean).join('\n\n') } }));
    }
  } finally { client.close(); }
}
// Hooks never block native work if the local table is temporarily unavailable.
main().catch(() => { process.stderr.write('Agentic Crafting Table could not synchronize this hook.\n'); });
