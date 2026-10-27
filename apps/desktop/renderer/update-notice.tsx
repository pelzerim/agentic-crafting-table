import { Toast } from './ui/notice.tsx';

export interface UpdateOffer { key: string; title: string; latest: string; plugin?: { id: string; source: string } }
/** One newer release, in the notice corner until the person opens it or closes it for that version (UPDATE-01). */
export function UpdateNotice({ offer, open, dismiss }: { offer: UpdateOffer; open(): void; dismiss(): void }) {
  const detail = offer.plugin ? 'Plugin pack · fetch and review it in Settings → Plugins' : 'Update from Settings → General';
  return <Toast tone="info" label={`${offer.title} ${offer.latest} is available`} title={`${offer.title} ${offer.latest} is available`} detail={detail}
    action={{ label: offer.plugin ? 'Review' : 'How to update', run: open }} dismiss={dismiss} dismissLabel={`Dismiss the ${offer.latest} update notice`} />;
}
