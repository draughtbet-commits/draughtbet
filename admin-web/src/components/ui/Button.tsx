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
      'inline-flex items-center justify-center font-medium rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#18C986]/50 disabled:opacity-50 disabled:cursor-not-allowed select-none';

    const variants = {
      primary: 'bg-[#18C986] text-[#000000] font-semibold hover:bg-[#13A46D] active:bg-[#13A46D]',
      secondary: 'bg-[#132638] text-[#F5F7FA] hover:bg-[#102131] active:bg-[#102131] border border-[#274056]',
      outline: 'border border-[#274056] text-[#F5F7FA] hover:bg-[#132638] hover:border-[#0E2E2B]',
      danger: 'bg-[#F55A67] text-white hover:bg-[#C93B40] active:bg-[#B03035]',
      ghost: 'text-[#8FA3B7] hover:text-[#F5F7FA] hover:bg-[#132638]'
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

