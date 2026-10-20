import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-solid' | 'copper' | 'icon';

/** Chrome is opt-in: `.btn` ignores the workspace's legacy button rules and owns its variants. */
export function Button({ variant = 'secondary', size = 'md', type = 'button', className, ...button }: { variant?: ButtonVariant; size?: 'sm' | 'md' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={className ? `btn ${className}` : 'btn'} data-variant={variant} data-size={size} {...button} />;
}
