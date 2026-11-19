'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/api/admin';
import type { AdminNotificationItem } from '@/lib/api/types';
import { Card, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDate } from '@/lib/utils';
import { Bell, RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react';

export default function NotificationHistoryPage() {
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [isReadFilter, setIsReadFilter] = useState<'all' | 'true' | 'false'>('all');
  const [typeFilter, setTypeFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadNotifications = useCallback(async (targetPage: number) => {
    try {
      const res = await adminApi.getNotifications({
        page: targetPage,
        limit: 20,
        search: search.trim() || undefined,
        type: typeFilter.trim() || undefined,
        isRead: isReadFilter === 'all' ? undefined : isReadFilter
      });
      setNotifications(res.notifications);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load notification history');
    } finally {
      setIsLoading(false);
    }
  }, [search, typeFilter, isReadFilter]);

  useEffect(() => {
    let active = true;
    adminApi
      .getNotifications({
        page,
        limit: 20,
        search: search.trim() || undefined,
        type: typeFilter.trim() || undefined,
        isRead: isReadFilter === 'all' ? undefined : isReadFilter
      })
      .then((res) => {
        if (!active) return;
        setNotifications(res.notifications);
        setTotal(res.total);
        setTotalPages(res.totalPages);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load notification history');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, search, typeFilter, isReadFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F7FA] tracking-tight flex items-center gap-2.5">
            <Bell className="w-6 h-6 text-[#18C986]" />
            Notification Delivery History
          </h1>
          <p className="text-sm text-[#8FA3B7] mt-1">
            Inspect persisted in-app notifications emitted across matches, deposits, withdrawals, and safer-play workflows.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setIsLoading(true);
            void loadNotifications(page);
          }}
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 text-[#8FA3B7] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              placeholder="Search title, message, type, or player email..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-[#08121E] border border-[#274056] text-[#F5F7FA] placeholder-[#52657A] focus:outline-none focus:border-[#18C986]"
            />
          </div>
          <input
            type="text"
            value={typeFilter}
            onChange={(e) => {
              setPage(1);
              setTypeFilter(e.target.value);
            }}
            placeholder="Filter exact type (e.g. MATCH_WIN)"
            className="px-3 py-2 text-sm rounded-lg bg-[#08121E] border border-[#274056] text-[#F5F7FA] placeholder-[#52657A] focus:outline-none focus:border-[#18C986]"
          />
          <select
            value={isReadFilter}
            onChange={(e) => {
              setPage(1);
              setIsReadFilter(e.target.value as 'all' | 'true' | 'false');
            }}
            className="px-3 py-2 text-sm rounded-lg bg-[#08121E] border border-[#274056] text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
          >
            <option value="all">All Read States</option>
            <option value="false">Unread Only</option>
            <option value="true">Read Only</option>
          </select>
        </div>

        {error && (
          <div className="p-3 mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between mb-3">
          <div>
            <CardTitle className="text-base">Recent Notifications</CardTitle>
            <CardDescription>{total} matching records</CardDescription>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#274056] text-[11px] uppercase tracking-wider text-[#8FA3B7]">
                <th className="py-2.5 pr-4">Created</th>
                <th className="py-2.5 pr-4">Recipient</th>
                <th className="py-2.5 pr-4">Type</th>
                <th className="py-2.5 pr-4">Title &amp; Message</th>
                <th className="py-2.5 pr-4">Match</th>
                <th className="py-2.5">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1A2F42] text-sm">
              {isLoading && notifications.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-[#8FA3B7]">
                    Loading notifications...
                  </td>
                </tr>
              ) : notifications.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-[#8FA3B7]">
                    No notifications found matching filters.
                  </td>
                </tr>
              ) : (
                notifications.map((item) => (
                  <tr key={item.id} className="hover:bg-[#0D1E2E]/60">
                    <td className="py-3 pr-4 whitespace-nowrap text-xs text-[#8FA3B7]">
                      {formatDate(item.createdAt)}
                    </td>
                    <td className="py-3 pr-4">
                      <div className="text-xs font-medium text-[#F5F7FA]">
                        {item.user?.email ?? item.userId}
                      </div>
                      {item.user?.username && (
                        <div className="text-[11px] text-[#8FA3B7]">@{item.user.username}</div>
                      )}
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      <Badge variant="info">{item.type}</Badge>
                    </td>
                    <td className="py-3 pr-4 max-w-md">
                      <div className="font-medium text-[#F5F7FA]">{item.title}</div>
                      <div className="text-xs text-[#8FA3B7] line-clamp-2">{item.message}</div>
                    </td>
                    <td className="py-3 pr-4 text-xs font-mono text-[#8FA3B7]">
                      {item.matchId ? item.matchId.slice(0, 8) : '—'}
                    </td>
                    <td className="py-3 whitespace-nowrap">
                      <Badge variant={item.isRead ? 'success' : 'warning'}>
                        {item.isRead ? 'Read' : 'Unread'}
                      </Badge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-4 mt-4 border-t border-[#1A2F42] text-xs text-[#8FA3B7]">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
