'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, helperText, type = 'text', id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          type={type}
          className={cn(
            'w-full h-10 px-3 bg-[#0C1B2A] border border-[#274056] rounded-lg text-sm text-[#F5F7FA] placeholder-[#53677A]',
            'focus:outline-none focus:border-[#18C986] focus:ring-1 focus:ring-[#18C986]',
            'disabled:opacity-50 disabled:bg-[#000000] transition-colors duration-150',
            error && 'border-[#F55A67] focus:border-[#F55A67] focus:ring-[#F55A67]',
            className
          )}
          {...props}
        />
        {error ? (
          <p className="text-xs text-[#F55A67] font-medium">{error}</p>
        ) : helperText ? (
          <p className="text-xs text-[#53677A]">{helperText}</p>
        ) : null}
      </div>
    );
  }
);

Input.displayName = 'Input';

