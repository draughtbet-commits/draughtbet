'use client';

import React, { useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { AlertCircle, RefreshCw } from 'lucide-react';

export default function ErrorBoundary({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log client error securely if logger exists
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] text-center p-4">
      <Card className="max-w-md w-full p-6 space-y-4 bg-[#15181D] border-[#2E333B]">
        <div className="inline-flex w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 items-center justify-center text-rose-400 mx-auto">
          <AlertCircle className="w-6 h-6" />
        </div>

        <div className="space-y-1">
          <h2 className="text-base font-bold text-[#F4F2ED]">Operational Error</h2>
          <p className="text-xs text-[#9CA3AF]">
            {error.message || 'An unexpected operational error occurred while rendering this module.'}
          </p>
        </div>

        <Button variant="secondary" size="sm" onClick={() => reset()} className="w-full gap-2">
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Retry Module</span>
        </Button>
      </Card>
    </div>
  );
}

