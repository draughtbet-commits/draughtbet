import React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'danger' | 'warning' | 'info' | 'gold';
  size?: 'sm' | 'md';
}

export function Badge({ className, variant = 'default', size = 'sm', children, ...props }: BadgeProps) {
  const variants = {
    default: 'bg-[#132638] text-[#8FA3B7] border-[#274056]',
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    danger: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    info: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    gold: 'bg-[#0E2E2B] text-[#18C986] border-[#18C986]/40'
  };

  const sizes = {
    sm: 'text-[11px] px-2 py-0.5 font-medium',
    md: 'text-xs px-2.5 py-1 font-semibold'
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border tracking-wide uppercase',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

