'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading = false, disabled, children, ...props }, ref) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 disabled:opacity-50 disabled:cursor-not-allowed select-none';

    const variants = {
      primary: 'bg-[#E7B24A] text-[#0B0D10] font-semibold hover:bg-[#B8862E] active:bg-[#B8862E]',
      secondary: 'bg-[#1E2229] text-[#F4F2ED] hover:bg-[#272C34] active:bg-[#272C34] border border-[#2E333B]',
      outline: 'border border-[#2E333B] text-[#F4F2ED] hover:bg-[#1E2229] hover:border-[#3A2E17]',
      danger: 'bg-[#E5484D] text-white hover:bg-[#C93B40] active:bg-[#B03035]',
      ghost: 'text-[#9CA3AF] hover:text-[#F4F2ED] hover:bg-[#1E2229]'
    };

    const sizes = {
      sm: 'h-8 px-3 text-xs gap-1.5',
      md: 'h-10 px-4 text-sm gap-2',
      lg: 'h-12 px-6 text-base gap-2.5'
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      >
        {isLoading && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

