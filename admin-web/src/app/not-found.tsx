import React from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ArrowLeft, FileQuestion } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#000000] text-center p-4">
      <Card className="max-w-md w-full p-8 space-y-5 bg-[#0C1B2A] border-[#274056]">
        <div className="inline-flex w-14 h-14 rounded-full bg-amber-500/10 border border-amber-500/30 items-center justify-center text-amber-400 mx-auto">
          <FileQuestion className="w-8 h-8" />
        </div>

        <div className="space-y-1">
          <h2 className="text-xl font-bold text-[#F5F7FA]">404 — Page Not Found</h2>
          <p className="text-xs text-[#8FA3B7]">
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

