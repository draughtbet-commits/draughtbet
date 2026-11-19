'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Crown, AlertCircle, ShieldAlert } from 'lucide-react';

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(identifier, password);
      router.push('/dashboard');
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Authentication failed. Please verify credentials.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Header Branding */}
        <div className="text-center space-y-2">
          <div className="inline-flex w-12 h-12 rounded-xl bg-[#0E2E2B] border border-[#18C986]/40 items-center justify-center text-[#18C986] shadow-lg mb-2">
            <Crown className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
            Draught Bet Administration
          </h1>
          <p className="text-xs text-[#8FA3B7]">
            Authorized personnel only. Access is monitored and audited.
          </p>
        </div>

        {/* Login Form Card */}
        <Card className="bg-[#0C1B2A] border-[#274056] p-6 shadow-xl">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-start gap-2.5 text-xs text-rose-400">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email or Phone"
              placeholder="operator@draughtbet.com"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoFocus
            />

            <Input
              label="Password"
              type="password"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            <Button
              type="submit"
              variant="primary"
              className="w-full mt-2"
              isLoading={isSubmitting}
            >
              Sign In to Console
            </Button>
          </form>

          <div className="mt-6 pt-4 border-t border-[#274056]/60 flex items-center justify-center gap-1.5 text-[11px] text-[#53677A]">
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Public self-registration is permanently disabled.</span>
          </div>
        </Card>
      </div>
    </div>
  );
}

