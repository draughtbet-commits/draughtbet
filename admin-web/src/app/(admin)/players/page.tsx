'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { adminApi } from '@/lib/api/admin';
import { useAuth } from '@/lib/auth/AuthContext';
import { PlayerListItem } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatDate } from '@/lib/utils';
import { PlayerDetailModal } from '@/components/players/PlayerDetailModal';
import {
  Users,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Eye,
  AlertCircle
} from 'lucide-react';

export default function PlayersPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [players, setPlayers] = useState<PlayerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [limit] = useState(15);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'banned'>('all');
  const [kycFilter, setKycFilter] = useState('all');
  const [sortBy, setSortBy] = useState('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected player for detail modal
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const fetchPlayers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await adminApi.getUsers({
        page,
        limit,
        search: submittedSearch.trim() || undefined,
        isBanned: statusFilter === 'banned' ? true : statusFilter === 'active' ? false : undefined,
        kycStatus: kycFilter !== 'all' ? kycFilter : undefined,
        sortBy,
        order
      });
      setPlayers(res.users || []);
      setTotal(res.total ?? (res.users ? res.users.length : 0));
      setTotalPages(Math.max(1, res.totalPages || 1));
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to load player directory.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [page, limit, submittedSearch, statusFilter, kycFilter, sortBy, order]);

  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    (async () => {
      setError(null);
      setIsLoading(true);
      try {
        const res = await adminApi.getUsers({
          page,
          limit,
          search: submittedSearch.trim() || undefined,
          isBanned: statusFilter === 'banned' ? true : statusFilter === 'active' ? false : undefined,
          kycStatus: kycFilter !== 'all' ? kycFilter : undefined,
          sortBy,
          order
        });
        if (!active) return;
        setPlayers(res.users || []);
        setTotal(res.total ?? (res.users ? res.users.length : 0));
        setTotalPages(Math.max(1, res.totalPages || 1));
      } catch (err: unknown) {
        if (!active) return;
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Failed to load player directory.');
        }
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [authLoading, user, page, limit, submittedSearch, statusFilter, kycFilter, sortBy, order]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedSearch(search);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold font-serif tracking-tight text-[#F5F7FA]">
            Player Directory
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Search and view registered players, account status, KYC verification state, and complete operational dossiers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchPlayers}
            isLoading={isLoading}
            className="gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={fetchPlayers}>
            Retry
          </Button>
        </div>
      )}

      {/* Filter and Search Bar */}
      <Card className="bg-[#0C1B2A] border-[#274056] p-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row gap-3">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8FA3B7]" />
            <input
              type="text"
              placeholder="Search by username, email, phone or name..."
              value={search}
              onChange={(e) => {
                const val = e.target.value;
                setSearch(val);
                if (val.trim() === '' && submittedSearch !== '') {
                  setSubmittedSearch('');
                  setPage(1);
                }
              }}
              className="w-full pl-9 pr-4 py-2 bg-[#132638] border border-[#274056] rounded-xl text-xs text-[#F5F7FA] placeholder-[#53677A] focus:outline-none focus:border-[#18C986]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Account Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as 'all' | 'active' | 'banned');
                setPage(1);
              }}
              className="px-3 py-2 bg-[#132638] border border-[#274056] rounded-xl text-xs text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
            >
              <option value="all">All Accounts</option>
              <option value="active">Active Only</option>
              <option value="banned">Suspended Only</option>
            </select>

            {/* KYC Status Filter */}
            <select
              value={kycFilter}
              onChange={(e) => {
                setKycFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 bg-[#132638] border border-[#274056] rounded-xl text-xs text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
            >
              <option value="all">All KYC States</option>
              <option value="NONE">KYC: None</option>
              <option value="PENDING">KYC: Pending</option>
              <option value="VERIFIED">KYC: Verified</option>
            </select>

            {/* Sort Filter */}
            <select
              value={`${sortBy}:${order}`}
              onChange={(e) => {
                const [s, o] = e.target.value.split(':');
                setSortBy(s);
                setOrder(o as 'asc' | 'desc');
                setPage(1);
              }}
              className="px-3 py-2 bg-[#132638] border border-[#274056] rounded-xl text-xs text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
            >
              <option value="createdAt:desc">Newest First</option>
              <option value="createdAt:asc">Oldest First</option>
              <option value="email:asc">Email (A-Z)</option>
              <option value="username:asc">Username (A-Z)</option>
            </select>

            <Button type="submit" variant="primary" size="sm">
              Search
            </Button>
          </div>
        </form>
      </Card>

      {/* Players Directory Table */}
      <Card className="p-0 overflow-hidden border-[#274056]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#132638] text-[#8FA3B7] border-b border-[#274056] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Player Details</th>
                <th className="py-3 px-4">Phone</th>
                <th className="py-3 px-4">Tier</th>
                <th className="py-3 px-4">KYC State</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Joined Date</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#274056]">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#8FA3B7]">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-[#18C986]" />
                    Loading player directory...
                  </td>
                </tr>
              ) : players.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#53677A]">
                    <Users className="w-8 h-8 mx-auto mb-2 opacity-40 text-[#18C986]" />
                    No players found matching your criteria.
                  </td>
                </tr>
              ) : (
                players.map((p) => (
                  <tr key={p.id} className="hover:bg-[#132638]/50 transition-colors">
                    <td className="py-3 px-4">
                      <div>
                        <div className="font-semibold text-[#F5F7FA]">
                          {p.username || p.fullName || 'Anonymous Player'}
                        </div>
                        <div className="font-mono text-[11px] text-[#8FA3B7]">
                          {p.email}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-[#8FA3B7]">
                      {p.phone || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant="gold">{p.tier}</Badge>
                    </td>
                    <td className="py-3 px-4">
                      <Badge
                        variant={
                          p.kycStatus === 'VERIFIED'
                            ? 'success'
                            : p.kycStatus === 'PENDING'
                            ? 'warning'
                            : 'default'
                        }
                      >
                        {p.kycStatus}
                      </Badge>
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={p.isBanned ? 'danger' : 'success'}>
                        {p.isBanned ? 'Suspended' : 'Active'}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                      {formatDate(p.createdAt)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setSelectedUserId(p.id)}
                        className="gap-1 text-xs"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Dossier</span>
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[#274056] bg-[#111317] text-xs text-[#8FA3B7]">
          <div>
            Showing <b className="text-[#F5F7FA]">{players.length}</b> of{' '}
            <b className="text-[#F5F7FA]">{total}</b> players
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Previous</span>
            </Button>
            <span className="font-mono text-[#F5F7FA] px-2">
              {page} / {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </Card>

      {/* Player Detail Dossier Modal */}
      {selectedUserId && (
        <PlayerDetailModal
          userId={selectedUserId}
          onClose={() => setSelectedUserId(null)}
          onUserUpdated={fetchPlayers}
        />
      )}
    </div>
  );
}
