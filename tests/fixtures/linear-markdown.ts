export const linearMarkdown = [
  '## Billing behavior',
  'Keep the current billing cycle. Show **effective dates**, *credits* and ~~old estimates~~ before confirming a change. Use `next_invoice_at` in the preview.',
  '### Implementation',
  '1. Load the subscription.\n   - Preserve the current plan.\n   - Calculate the next invoice.\n2. Show the customer a preview.',
  '- [x] Keep the existing cycle\n- [ ] Confirm the downgrade date',
  '> Changes take effect on the next billing cycle.\n> Explain the date before saving.',
  '| Change | Effective date |\n| --- | --- |\n| Upgrade | Immediately |\n| Downgrade | Next billing cycle |',
  '```ts\nconst change = {\n  effectiveAt: "next_billing_cycle",\n  preserveCredits: true,\n};\n```',
  '[Implementation guide](https://example.test/billing?view=changes#preview) and https://example.test/reference.',
  '![Billing screenshot](https://images.example.test/billing.png)',
  '---',
  '<script>window.linearInjected=true</script>',
  '<img src="https://images.example.test/tracker" onerror="window.linearInjected=true">',
  '[Unsafe link](javascript:alert%281%29) · [Local file](file:///tmp/secret) · [Credential URL](https://user:secret@example.test/)',
].join('\n\n');

export const wideLinearMarkdown = [
  '# Wide content',
  'A description should wrap inside the ticket. '.repeat(8),
  '| Endpoint | Response | Owner | Plan | Region | Status | Date | Version | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| /billing/change | Preview | Billing | Pro | EU | Ready | Tomorrow | v2 | Check the invoice |',
  '```ts\nconst plans = [' + Array.from({ length: 30 }, (_, i) => `"plan-${i}"`).join(', ') + '];\n```',
  'End of description.',
].join('\n\n');
