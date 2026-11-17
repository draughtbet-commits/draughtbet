import React from 'react';
import { Card, CardTitle, CardDescription } from '@/components/ui/Card';
import { Receipt } from 'lucide-react';

export default function LedgerPage() {
  return (
    <div className="space-y-6">
      <div className="pb-2 border-b border-[#2E333B]">
        <h1 className="text-2xl font-bold tracking-tight text-[#F4F2ED]">
          Double-Entry Ledger Explorer
        </h1>
        <p className="text-xs text-[#9CA3AF] mt-0.5">
          Immutable financial transactions, balanced entries, account balances, and sanctioned adjustments.
        </p>
      </div>

      <Card className="text-center py-12">
        <Receipt className="w-12 h-12 text-[#E7B24A] mx-auto mb-3 opacity-60" />
        <CardTitle className="text-base">Ledger Transactions & Adjustments</CardTitle>
        <CardDescription className="max-w-md mx-auto mt-2">
          Scheduled for Phase 3 implementation. Powered by the Backend V2 double-entry LedgerService and AdminAdjustment endpoints.
        </CardDescription>
      </Card>
    </div>
  );
}

