import { useNotice } from './use-notice.ts';
import type { CompletionNotice as Notice } from './use-attention.ts';
import { Toast } from './ui/notice.tsx';

export function CompletionNotice({ notice, open }: { notice: Notice; open(id: string): void }) {
  const visibility = useNotice(notice, !notice.failed);
  if (!visibility.visible) return null;
  if (notice.failed) return <Toast tone="error" label={notice.note ?? `${notice.title} didn’t go through`} title={notice.note ?? notice.title} detail={`${notice.title} · open it for the reason`}
    action={{ label: 'Open', run: () => { open(notice.nodeId); visibility.dismiss(); } }} dismiss={visibility.dismiss} dismissLabel={`Dismiss notification: ${notice.note ?? notice.title}`} />;
  return <Toast tone={notice.unblocked ? 'unblocked' : 'done'} label={notice.unblocked ? `${notice.title} is unblocked` : `${notice.title} finished`}
    title={notice.title} detail={notice.unblocked ? 'Unblocked · its blockers are done' : notice.note ?? 'Finished · ready to view'}
    action={{ label: 'Open', run: () => { open(notice.nodeId); visibility.dismiss(); } }}
    dismiss={visibility.dismiss} dismissLabel={`Dismiss notification: ${notice.title}`} />;
}
