import type { HTMLAttributes, ReactNode } from 'react';

export type ChipTone = 'ok' | 'pending' | 'error' | 'info' | 'neutral' | 'agent';

/** One status chip: tone carries meaning, variant only weight. Plugins map their states onto these tones. */
export function Chip({ tone = 'neutral', variant = 'soft', children, className, ...span }: { tone?: ChipTone; variant?: 'soft' | 'outline' | 'mono'; children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={className ? `act-chip ${className}` : 'act-chip'} data-tone={tone} data-variant={variant} {...span}>{children}</span>;
}
