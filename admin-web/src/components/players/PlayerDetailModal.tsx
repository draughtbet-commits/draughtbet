'use client';

import React, { useState, useEffect } from 'react';
import { adminApi } from '@/lib/api/admin';
import { PlayerDetailResponse } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatNaira, formatDate } from '@/lib/utils';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import {
  X,
  User,
  ShieldCheck,
  Wallet,
  Swords,
  Laptop,
  FileText,
  AlertTriangle,
  Ban,
  CheckCircle,
  RefreshCw,
  Lock
} from 'lucide-react';

interface PlayerDetailModalProps {
  userId: string;
  onClose: () => void;
  onUserUpdated?: () => void;
}

type TabType =
  | 'overview'
  | 'kyc'
  | 'wallet'
  | 'matches'
  | 'withdrawals'
  | 'saferplay'
  | 'sessions'
  | 'adminHistory';

export function PlayerDetailModal({ userId, onClose, onUserUpdated }: PlayerDetailModalProps) {
  const { user: currentAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [data, setData] = useState<PlayerDetailResponse['user'] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [confirmBanModal, setConfirmBanModal] = useState(false);

  const canManageUsers = canAccessPermission(currentAdmin, PERMISSIONS.USERS_MANAGE);
  const canLiftSaferPlay = canAccessPermission(currentAdmin, PERMISSIONS.SAFER_PLAY_LIFT);

  const fetchPlayerDetail = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await adminApi.getUserDetail(userId);
      setData(res.user);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to load player details.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    adminApi.getUserDetail(userId)
      .then((res) => {
        if (!active) return;
        setData(res.user);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Failed to load player details.');
        }
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId]);

  const handleToggleBan = async () => {
    if (!data) return;
    setActionLoading(true);
    setError(null);
    setActionSuccess(null);
    try {
      if (data.isBanned) {
        await adminApi.unbanUser(data.id);
        setActionSuccess('Account successfully reinstated.');
      } else {
        await adminApi.banUser(data.id);
        setActionSuccess('Account successfully suspended.');
      }
      setConfirmBanModal(false);
      await fetchPlayerDetail();
      onUserUpdated?.();
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to update account status.');
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleClearTimeout = async () => {
    if (!data) return;
    setActionLoading(true);
    setError(null);
    setActionSuccess(null);
    try {
      await adminApi.clearTimeout(data.id);
      setActionSuccess('Safer-play timeout lifted.');
      await fetchPlayerDetail();
      onUserUpdated?.();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to lift timeout.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleEndSelfExclusion = async () => {
    if (!data) return;
    setActionLoading(true);
    setError(null);
    setActionSuccess(null);
    try {
      await adminApi.endSelfExclusion(data.id);
      setActionSuccess('Self-exclusion lifted by authorized administrator.');
      await fetchPlayerDetail();
      onUserUpdated?.();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to end self-exclusion.');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-5xl max-h-[92vh] flex flex-col rounded-2xl bg-[#15181D] border border-[#2E333B] shadow-2xl overflow-hidden text-[#F4F2ED]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2E333B] bg-[#111317]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#1E2229] border border-[#2E333B] flex items-center justify-center text-[#E7B24A] font-bold">
              {data?.username ? data.username[0].toUpperCase() : 'P'}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold font-serif text-[#F4F2ED]">
                  {data?.username || data?.email || 'Player Detail'}
                </h2>
                {data && (
                  <Badge variant={data.isBanned ? 'danger' : 'success'}>
                    {data.isBanned ? 'Suspended' : 'Active'}
                  </Badge>
                )}
                {data?.kycStatus && (
                  <Badge
                    variant={
                      data.kycStatus === 'VERIFIED'
                        ? 'success'
                        : data.kycStatus === 'PENDING'
                        ? 'warning'
                        : 'default'
                    }
                  >
                    KYC: {data.kycStatus}
                  </Badge>
                )}
              </div>
              <span className="text-xs text-[#9CA3AF] font-mono">
                ID: {userId}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchPlayerDetail}
              isLoading={isLoading}
              className="text-[#9CA3AF] hover:text-[#F4F2ED]"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-[#F4F2ED] hover:bg-[#1E2229] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-[#2E333B] bg-[#15181D] px-6 overflow-x-auto text-xs font-semibold">
          {[
            { id: 'overview', label: 'Overview', icon: User },
            { id: 'kyc', label: 'KYC & Verification', icon: ShieldCheck },
            { id: 'wallet', label: 'Wallet & Ledger', icon: Wallet },
            { id: 'matches', label: 'Match History', icon: Swords },
            { id: 'withdrawals', label: 'Withdrawals', icon: Wallet },
            { id: 'saferplay', label: 'Safer Play', icon: AlertTriangle },
            { id: 'sessions', label: 'Sessions & Devices', icon: Laptop },
            { id: 'adminHistory', label: 'Admin Trail', icon: FileText }
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabType)}
                className={`flex items-center gap-2 py-3 px-3.5 border-b-2 whitespace-nowrap transition-colors ${
                  isActive
                    ? 'border-[#E7B24A] text-[#E7B24A]'
                    : 'border-transparent text-[#9CA3AF] hover:text-[#F4F2ED]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Messages */}
        {actionSuccess && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center gap-2">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{actionSuccess}</span>
          </div>
        )}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading ? (
            <div className="py-20 text-center text-[#9CA3AF] text-sm">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-[#E7B24A]" />
              Loading player dossier...
            </div>
          ) : !data ? (
            <div className="py-20 text-center text-rose-400 text-sm">
              Failed to load player data.
            </div>
          ) : (
            <>
              {/* TAB 1: OVERVIEW */}
              {activeTab === 'overview' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Card className="bg-[#1A1D24] border-[#2E333B]">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-4">
                        Identity & Account
                      </h3>
                      <dl className="space-y-2.5 text-xs">
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">User ID</dt>
                          <dd className="font-mono text-[#F4F2ED]">{data.id}</dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Email</dt>
                          <dd className="font-mono text-[#F4F2ED]">{data.email}</dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Username</dt>
                          <dd className="text-[#F4F2ED]">{data.username || '—'}</dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Full Name</dt>
                          <dd className="text-[#F4F2ED]">{data.fullName || '—'}</dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Phone</dt>
                          <dd className="font-mono text-[#F4F2ED]">{data.phone || '—'}</dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Country</dt>
                          <dd className="text-[#F4F2ED]">{data.countryCode || 'NG'}</dd>
                        </div>
                        <div className="flex justify-between py-1">
                          <dt className="text-[#9CA3AF]">Joined At</dt>
                          <dd className="font-mono text-[#F4F2ED]">{formatDate(data.createdAt)}</dd>
                        </div>
                      </dl>
                    </Card>

                    <Card className="bg-[#1A1D24] border-[#2E333B]">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-4">
                        Gaming & Tier Details
                      </h3>
                      <dl className="space-y-2.5 text-xs">
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Competition Tier</dt>
                          <dd>
                            <Badge variant="gold">{data.tier}</Badge>
                          </dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Age Verified</dt>
                          <dd>
                            <Badge variant={data.ageVerified ? 'success' : 'default'}>
                              {data.ageVerified ? 'Verified 18+' : 'Unverified'}
                            </Badge>
                          </dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Total Matches</dt>
                          <dd className="font-mono text-[#F4F2ED]">{data.matches?.length ?? 0}</dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Role Privileges</dt>
                          <dd className="text-[#F4F2ED]">
                            {data.isAdmin ? (
                              <Badge variant="gold">Platform Staff</Badge>
                            ) : (
                              <span className="text-[#9CA3AF]">Player</span>
                            )}
                          </dd>
                        </div>
                        <div className="flex justify-between py-1">
                          <dt className="text-[#9CA3AF]">Status</dt>
                          <dd>
                            <Badge variant={data.isBanned ? 'danger' : 'success'}>
                              {data.isBanned ? 'Suspended' : 'In Good Standing'}
                            </Badge>
                          </dd>
                        </div>
                      </dl>
                    </Card>
                  </div>

                  {/* Account Actions Bar */}
                  {canManageUsers && (
                    <div className="p-4 rounded-xl bg-[#1E2229] border border-[#2E333B] flex items-center justify-between">
                      <div>
                        <h4 className="text-xs font-bold text-[#F4F2ED]">
                          Administrative Status Mutation
                        </h4>
                        <p className="text-[11px] text-[#9CA3AF] mt-0.5">
                          {data.isBanned
                            ? 'Reinstates the player account and permits login and gameplay.'
                            : 'Suspends the player account, revokes active sessions and socket connections.'}
                        </p>
                      </div>
                      <Button
                        variant={data.isBanned ? 'primary' : 'danger'}
                        size="sm"
                        onClick={() => setConfirmBanModal(true)}
                        isLoading={actionLoading}
                      >
                        {data.isBanned ? (
                          <>
                            <CheckCircle className="w-3.5 h-3.5 mr-1" />
                            <span>Reinstate Account</span>
                          </>
                        ) : (
                          <>
                            <Ban className="w-3.5 h-3.5 mr-1" />
                            <span>Suspend Account</span>
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: KYC */}
              {activeTab === 'kyc' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-xl bg-[#1E2229] border border-[#2E333B]">
                    <div>
                      <span className="text-xs text-[#9CA3AF] block uppercase">Current KYC Status</span>
                      <span className="text-base font-bold text-[#F4F2ED]">{data.kycStatus}</span>
                    </div>
                    <Badge
                      variant={
                        data.kycStatus === 'VERIFIED'
                          ? 'success'
                          : data.kycStatus === 'PENDING'
                          ? 'warning'
                          : 'default'
                      }
                      size="md"
                    >
                      {data.kycStatus}
                    </Badge>
                  </div>

                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] pt-2">
                    Verification History & Submissions
                  </h3>
                  {data.verificationCases?.length === 0 ? (
                    <p className="text-xs text-[#6B7280] py-6 text-center">
                      No verification cases registered for this player.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {data.verificationCases.map((vc) => (
                        <div
                          key={vc.id}
                          className="p-4 rounded-xl bg-[#1A1D24] border border-[#2E333B] text-xs space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[#9CA3AF]">Case ID: {vc.id}</span>
                            <Badge
                              variant={
                                vc.status === 'VERIFIED'
                                  ? 'success'
                                  : vc.status === 'REJECTED'
                                  ? 'danger'
                                  : 'warning'
                              }
                            >
                              {vc.status}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4 text-[#9CA3AF]">
                            <span>Provider: {vc.provider || 'simulated'}</span>
                            <span>Created: {formatDate(vc.createdAt)}</span>
                          </div>
                          {vc.checks && vc.checks.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-[#2E333B]/40 flex flex-wrap gap-2">
                              {vc.checks.map((chk) => (
                                <span
                                  key={chk.id}
                                  className="px-2 py-0.5 rounded bg-[#111317] border border-[#2E333B] font-mono text-[10px] text-[#9CA3AF]"
                                >
                                  {chk.type}: <b className="text-[#F4F2ED]">{chk.status}</b>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: WALLET & LEDGER */}
              {activeTab === 'wallet' && (
                <div className="space-y-4">
                  {data.financials ? (
                    <>
                      {/* Projections Bar */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <Card className="bg-[#1A1D24] border-[#2E333B]">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF]">
                            Available Balance
                          </span>
                          <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                            {formatNaira(data.financials.projections.available)}
                          </div>
                          <span className="text-[11px] text-[#9CA3AF]">Withdrawable & Playable</span>
                        </Card>
                        <Card className="bg-[#1A1D24] border-[#2E333B]">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF]">
                            Locked in Matches
                          </span>
                          <div className="text-xl font-bold font-mono text-amber-400 mt-1">
                            {formatNaira(data.financials.projections.locked)}
                          </div>
                          <span className="text-[11px] text-[#9CA3AF]">Escrow Stake Hold</span>
                        </Card>
                        <Card className="bg-[#1A1D24] border-[#2E333B]">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF]">
                            Pending Withdrawal
                          </span>
                          <div className="text-xl font-bold font-mono text-sky-400 mt-1">
                            {formatNaira(data.financials.projections.pending)}
                          </div>
                          <span className="text-[11px] text-[#9CA3AF]">Awaiting Payout Gate</span>
                        </Card>
                      </div>

                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] pt-2">
                        Recent Ledger Postings (Double-Entry Log)
                      </h3>
                      {data.financials.recentEntries.length === 0 ? (
                        <p className="text-xs text-[#6B7280] py-6 text-center">
                          No ledger postings found for this user account.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-[#1E2229] text-[#9CA3AF] border-y border-[#2E333B] uppercase text-[10px] tracking-wider">
                              <tr>
                                <th className="py-2.5 px-3">Date</th>
                                <th className="py-2.5 px-3">Direction</th>
                                <th className="py-2.5 px-3">Amount</th>
                                <th className="py-2.5 px-3">Reference</th>
                                <th className="py-2.5 px-3">Description</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#2E333B]">
                              {data.financials.recentEntries.map((e) => (
                                <tr key={e.id} className="hover:bg-[#1E2229]/50">
                                  <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                    {formatDate(e.createdAt)}
                                  </td>
                                  <td className="py-2 px-3">
                                    <Badge variant={e.direction === 'CREDIT' ? 'success' : 'danger'}>
                                      {e.direction}
                                    </Badge>
                                  </td>
                                  <td className="py-2 px-3 font-mono font-bold text-[#F4F2ED]">
                                    {formatNaira(e.amountMinorUnits)}
                                  </td>
                                  <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                    {e.reference}
                                  </td>
                                  <td className="py-2 px-3 text-[#9CA3AF]">
                                    {e.description || '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="py-12 text-center text-xs text-[#9CA3AF] space-y-2">
                      <Lock className="w-8 h-8 text-[#E7B24A] mx-auto opacity-50" />
                      <p className="font-semibold text-[#F4F2ED]">Financial Access Restricted</p>
                      <p className="max-w-sm mx-auto text-[#6B7280]">
                        Viewing player balances and ledger transactions requires the FINANCE or SUPER_ADMIN role.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 4: MATCHES */}
              {activeTab === 'matches' && (
                <div className="space-y-4">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF]">
                    Recent Match History
                  </h3>
                  {data.matches.length === 0 ? (
                    <p className="text-xs text-[#6B7280] py-6 text-center">
                      No matches played yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#1E2229] text-[#9CA3AF] border-y border-[#2E333B] uppercase text-[10px] tracking-wider">
                          <tr>
                            <th className="py-2.5 px-3">Match ID</th>
                            <th className="py-2.5 px-3">Tier</th>
                            <th className="py-2.5 px-3">Stake</th>
                            <th className="py-2.5 px-3">Status</th>
                            <th className="py-2.5 px-3">Outcome</th>
                            <th className="py-2.5 px-3">Date</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#2E333B]">
                          {data.matches.map((m) => {
                            const isWinner = m.winnerId === data.id;
                            return (
                              <tr key={m.id} className="hover:bg-[#1E2229]/50">
                                <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                  {m.id.slice(0, 8)}...
                                </td>
                                <td className="py-2 px-3">
                                  <Badge variant="gold">{m.tier}</Badge>
                                </td>
                                <td className="py-2 px-3 font-mono font-bold text-[#F4F2ED]">
                                  {formatNaira(m.stakeMinorUnits)}
                                </td>
                                <td className="py-2 px-3">
                                  <Badge
                                    variant={
                                      m.status === 'COMPLETED'
                                        ? 'success'
                                        : m.status === 'ACTIVE'
                                        ? 'warning'
                                        : 'default'
                                    }
                                  >
                                    {m.status}
                                  </Badge>
                                </td>
                                <td className="py-2 px-3">
                                  {m.status === 'COMPLETED' ? (
                                    isWinner ? (
                                      <span className="text-emerald-400 font-bold">VICTORY</span>
                                    ) : m.winnerId ? (
                                      <span className="text-rose-400 font-bold">DEFEAT</span>
                                    ) : (
                                      <span className="text-amber-400 font-bold">DRAW</span>
                                    )
                                  ) : (
                                    <span className="text-[#9CA3AF]">—</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                  {formatDate(m.createdAt)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 5: WITHDRAWALS */}
              {activeTab === 'withdrawals' && (
                <div className="space-y-4">
                  {data.financials ? (
                    <>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF]">
                        Player Withdrawal History
                      </h3>
                      {data.financials.withdrawals.length === 0 ? (
                        <p className="text-xs text-[#6B7280] py-6 text-center">
                          No withdrawals recorded for this player.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-[#1E2229] text-[#9CA3AF] border-y border-[#2E333B] uppercase text-[10px] tracking-wider">
                              <tr>
                                <th className="py-2.5 px-3">Reference</th>
                                <th className="py-2.5 px-3">Amount</th>
                                <th className="py-2.5 px-3">Status</th>
                                <th className="py-2.5 px-3">Bank Destination</th>
                                <th className="py-2.5 px-3">Date</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#2E333B]">
                              {data.financials.withdrawals.map((w) => (
                                <tr key={w.id} className="hover:bg-[#1E2229]/50">
                                  <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                    {w.reference}
                                  </td>
                                  <td className="py-2 px-3 font-mono font-bold text-[#F4F2ED]">
                                    {formatNaira(w.amountMinorUnits)}
                                  </td>
                                  <td className="py-2 px-3">
                                    <Badge
                                      variant={
                                        w.status === 'COMPLETED'
                                          ? 'success'
                                          : w.status === 'PENDING_REVIEW'
                                          ? 'warning'
                                          : w.status === 'FAILED'
                                          ? 'danger'
                                          : 'info'
                                      }
                                    >
                                      {w.status}
                                    </Badge>
                                  </td>
                                  <td className="py-2 px-3 text-[#9CA3AF]">
                                    {w.bankAccount
                                      ? `${w.bankAccount.bankName} (${w.bankAccount.accountNumber})`
                                      : '—'}
                                  </td>
                                  <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                    {formatDate(w.createdAt)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="py-12 text-center text-xs text-[#9CA3AF] space-y-2">
                      <Lock className="w-8 h-8 text-[#E7B24A] mx-auto opacity-50" />
                      <p className="font-semibold text-[#F4F2ED]">Withdrawal Access Restricted</p>
                      <p className="max-w-sm mx-auto text-[#6B7280]">
                        Viewing withdrawal records requires the FINANCE or SUPER_ADMIN role.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 6: SAFER PLAY */}
              {activeTab === 'saferplay' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Card className="bg-[#1A1D24] border-[#2E333B]">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-3">
                        Active Restrictions
                      </h4>
                      <dl className="space-y-2 text-xs">
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Timeout Status</dt>
                          <dd>
                            {data.saferPlayProfile?.timeoutUntil &&
                            new Date(data.saferPlayProfile.timeoutUntil) > new Date() ? (
                              <Badge variant="warning">
                                Active until {formatDate(data.saferPlayProfile.timeoutUntil)}
                              </Badge>
                            ) : (
                              <span className="text-[#9CA3AF]">None</span>
                            )}
                          </dd>
                        </div>
                        <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                          <dt className="text-[#9CA3AF]">Self-Exclusion</dt>
                          <dd>
                            {data.saferPlayProfile?.selfExclusionUntil &&
                            new Date(data.saferPlayProfile.selfExclusionUntil) > new Date() ? (
                              <Badge variant="danger">
                                Active until {formatDate(data.saferPlayProfile.selfExclusionUntil)}
                              </Badge>
                            ) : (
                              <span className="text-[#9CA3AF]">None</span>
                            )}
                          </dd>
                        </div>
                        <div className="flex justify-between py-1">
                          <dt className="text-[#9CA3AF]">Deposit Limit (Daily)</dt>
                          <dd className="font-mono text-[#F4F2ED]">
                            {data.saferPlayProfile?.dailyDepositLimitMinorUnits
                              ? formatNaira(data.saferPlayProfile.dailyDepositLimitMinorUnits)
                              : 'No limit set'}
                          </dd>
                        </div>
                      </dl>
                    </Card>

                    {canLiftSaferPlay && (
                      <Card className="bg-[#1A1D24] border-[#2E333B] flex flex-col justify-between">
                        <div>
                          <h4 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-2">
                            Operator Safer-Play Interventions
                          </h4>
                          <p className="text-[11px] text-[#9CA3AF]">
                            Sanctioned actions to lift cooldown timeouts or early end self-exclusion upon compliance review.
                          </p>
                        </div>
                        <div className="flex flex-col gap-2 mt-4">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleClearTimeout}
                            isLoading={actionLoading}
                            disabled={
                              !data.saferPlayProfile?.timeoutUntil ||
                              new Date(data.saferPlayProfile.timeoutUntil) <= new Date()
                            }
                          >
                            Lift Active Timeout
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={handleEndSelfExclusion}
                            isLoading={actionLoading}
                            disabled={
                              !data.saferPlayProfile?.selfExclusionUntil ||
                              new Date(data.saferPlayProfile.selfExclusionUntil) <= new Date()
                            }
                          >
                            End Self-Exclusion Early
                          </Button>
                        </div>
                      </Card>
                    )}
                  </div>

                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] pt-2">
                    Safer Play Audit History
                  </h3>
                  {data.saferPlayEvents?.length === 0 ? (
                    <p className="text-xs text-[#6B7280] py-6 text-center">
                      No safer play limit changes or timeouts on record.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {data.saferPlayEvents.map((ev) => (
                        <div
                          key={ev.id}
                          className="p-3 rounded-lg bg-[#1A1D24] border border-[#2E333B] text-xs flex items-center justify-between"
                        >
                          <div>
                            <span className="font-bold text-[#F4F2ED]">{ev.action}</span>
                            <span className="text-[#9CA3AF] ml-2">Field: {ev.field}</span>
                          </div>
                          <span className="font-mono text-[11px] text-[#9CA3AF]">
                            {formatDate(ev.createdAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 7: SESSIONS & DEVICES */}
              {activeTab === 'sessions' && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-3">
                      Recent Active Sessions
                    </h3>
                    {data.sessions?.length === 0 ? (
                      <p className="text-xs text-[#6B7280] py-4 text-center">
                        No session tokens active.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-[#1E2229] text-[#9CA3AF] border-y border-[#2E333B] uppercase text-[10px]">
                            <tr>
                              <th className="py-2 px-3">Session ID</th>
                              <th className="py-2 px-3">IP Address</th>
                              <th className="py-2 px-3">Status</th>
                              <th className="py-2 px-3">User Agent</th>
                              <th className="py-2 px-3">Expires</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#2E333B]">
                            {data.sessions.map((s) => (
                              <tr key={s.id} className="hover:bg-[#1E2229]/50">
                                <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                  {s.id.slice(0, 8)}...
                                </td>
                                <td className="py-2 px-3 font-mono text-[#F4F2ED]">
                                  {s.ipAddress || '—'}
                                </td>
                                <td className="py-2 px-3">
                                  <Badge variant={s.status === 'ACTIVE' ? 'success' : 'default'}>
                                    {s.status}
                                  </Badge>
                                </td>
                                <td className="py-2 px-3 text-[#9CA3AF] truncate max-w-xs">
                                  {s.userAgent || '—'}
                                </td>
                                <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                  {formatDate(s.expiresAt)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-3">
                      Observed Device Fingerprints
                    </h3>
                    {data.devices?.length === 0 ? (
                      <p className="text-xs text-[#6B7280] py-4 text-center">
                        No device fingerprints logged.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {data.devices.map((d) => (
                          <div
                            key={d.id}
                            className="p-3 rounded-lg bg-[#1A1D24] border border-[#2E333B] text-xs flex items-center justify-between"
                          >
                            <span className="font-mono text-[#E7B24A]">
                              Hash: {d.fingerprintHash}
                            </span>
                            <span className="text-[#9CA3AF] font-mono text-[11px]">
                              Last seen: {formatDate(d.lastSeen)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 8: ADMIN TRAIL */}
              {activeTab === 'adminHistory' && (
                <div className="space-y-4">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF]">
                    Privileged Action Trail Touching this Player
                  </h3>
                  {data.adminHistory?.length === 0 ? (
                    <p className="text-xs text-[#6B7280] py-6 text-center">
                      No administrative actions logged on this user yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#1E2229] text-[#9CA3AF] border-y border-[#2E333B] uppercase text-[10px]">
                          <tr>
                            <th className="py-2 px-3">Date</th>
                            <th className="py-2 px-3">Action</th>
                            <th className="py-2 px-3">Outcome</th>
                            <th className="py-2 px-3">Admin ID</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#2E333B]">
                          {data.adminHistory.map((h) => (
                            <tr key={h.id} className="hover:bg-[#1E2229]/50">
                              <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                {formatDate(h.createdAt)}
                              </td>
                              <td className="py-2 px-3 font-bold text-[#F4F2ED]">{h.action}</td>
                              <td className="py-2 px-3">
                                <Badge variant={h.outcome === 'SUCCESS' ? 'success' : 'danger'}>
                                  {h.outcome}
                                </Badge>
                              </td>
                              <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                                {h.adminId.slice(0, 8)}...
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Confirmation Modal for Suspension */}
        {confirmBanModal && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-md p-6 rounded-xl bg-[#1E2229] border border-[#2E333B] shadow-2xl space-y-4">
              <h3 className="text-sm font-bold text-[#F4F2ED] flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                Confirm Account {data?.isBanned ? 'Reinstatement' : 'Suspension'}
              </h3>
              <p className="text-xs text-[#9CA3AF]">
                Are you sure you want to {data?.isBanned ? 'reinstate' : 'suspend'}{' '}
                <b className="text-[#F4F2ED]">{data?.username || data?.email}</b>?{' '}
                This consequential action will be logged in the immutable audit trail.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmBanModal(false)}
                  disabled={actionLoading}
                >
                  Cancel
                </Button>
                <Button
                  variant={data?.isBanned ? 'primary' : 'danger'}
                  size="sm"
                  onClick={handleToggleBan}
                  isLoading={actionLoading}
                >
                  Confirm {data?.isBanned ? 'Reinstatement' : 'Suspension'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
