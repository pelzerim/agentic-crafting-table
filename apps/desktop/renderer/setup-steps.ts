import type { ProviderDescription, ProviderSetupStep } from '../../../packages/core/connections.ts';

const commandLine = /^(?:\$\s+(.+)|([a-z][\w.-]*(?:\s+\S+)*\s+-{1,2}[\w-]+(?:\s+\S+)*))$/;

/** Structured steps when a provider declares them; otherwise numbered lines of the
 * legacy `setupHint`, with bare Terminal commands attached to their step. */
export function providerSetupSteps(provider: Pick<ProviderDescription, 'setupHint' | 'setupSteps'>): ProviderSetupStep[] {
  if (provider.setupSteps?.length) return provider.setupSteps;
  const steps: ProviderSetupStep[] = [];
  for (const paragraph of provider.setupHint.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    const numbered = /^\d+[.)]\s+(.+)$/.exec(paragraph)?.[1], command = commandLine.exec(paragraph);
    const last = steps.at(-1);
    if (command && !/[.!?:]$/.test(paragraph) && last && !last.command) last.command = command[1] ?? command[2];
    else if (numbered || !last) steps.push({ text: numbered ?? paragraph });
    else last.text += ` ${paragraph}`;
  }
  return steps;
}
