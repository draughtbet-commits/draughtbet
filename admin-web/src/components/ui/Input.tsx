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
          <label htmlFor={inputId} className="block text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          type={type}
          className={cn(
            'w-full h-10 px-3 bg-[#15181D] border border-[#2E333B] rounded-lg text-sm text-[#F4F2ED] placeholder-[#6B7280]',
            'focus:outline-none focus:border-[#E7B24A] focus:ring-1 focus:ring-[#E7B24A]',
            'disabled:opacity-50 disabled:bg-[#0B0D10] transition-colors duration-150',
            error && 'border-[#E5484D] focus:border-[#E5484D] focus:ring-[#E5484D]',
            className
          )}
          {...props}
        />
        {error ? (
          <p className="text-xs text-[#E5484D] font-medium">{error}</p>
        ) : helperText ? (
          <p className="text-xs text-[#6B7280]">{helperText}</p>
        ) : null}
      </div>
    );
  }
);

Input.displayName = 'Input';

