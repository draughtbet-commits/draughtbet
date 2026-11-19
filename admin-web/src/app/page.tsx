'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return (
    <div className="min-h-screen bg-[#000000] flex flex-col items-center justify-center text-[#F5F7FA] gap-3">
      <Loader2 className="w-8 h-8 text-[#18C986] animate-spin" />
      <span className="text-xs uppercase tracking-widest text-[#8FA3B7]">
        Loading Console...
      </span>
    </div>
  );
}
