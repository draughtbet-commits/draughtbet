import React from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ArrowLeft, FileQuestion } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#0B0D10] text-center p-4">
      <Card className="max-w-md w-full p-8 space-y-5 bg-[#15181D] border-[#2E333B]">
        <div className="inline-flex w-14 h-14 rounded-full bg-amber-500/10 border border-amber-500/30 items-center justify-center text-amber-400 mx-auto">
          <FileQuestion className="w-8 h-8" />
        </div>

        <div className="space-y-1">
          <h2 className="text-xl font-bold text-[#F4F2ED]">404 — Page Not Found</h2>
          <p className="text-xs text-[#9CA3AF]">
            The requested administration view does not exist or has been relocated.
          </p>
        </div>

        <Link href="/dashboard" className="block w-full">
          <Button variant="secondary" className="w-full gap-2">
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Dashboard</span>
          </Button>
        </Link>
      </Card>
    </div>
  );
}

