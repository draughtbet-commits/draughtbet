import React from 'react';
import { Card, CardTitle, CardDescription } from '@/components/ui/Card';
import { Sliders } from 'lucide-react';

export default function ConfigurationPage() {
  return (
    <div className="space-y-6">
      <div className="pb-2 border-b border-[#2E333B]">
        <h1 className="text-2xl font-bold tracking-tight text-[#F4F2ED]">
          Platform Configuration & Rulesets
        </h1>
        <p className="text-xs text-[#9CA3AF] mt-0.5">
          Versioned platform parameters, stake limits, commission rates, and time controls.
        </p>
      </div>

      <Card className="text-center py-12">
        <Sliders className="w-12 h-12 text-[#E7B24A] mx-auto mb-3 opacity-60" />
        <CardTitle className="text-base">Versioned Platform Settings</CardTitle>
        <CardDescription className="max-w-md mx-auto mt-2">
          Scheduled for Phase 4. Configuration changes produce immutable version records; active funded matches always retain their frozen initial snapshots.
        </CardDescription>
      </Card>
    </div>
  );
}

