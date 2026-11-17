'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api/admin';
import { AuditLogItem } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { formatDate } from '@/lib/utils';
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Search,
  Eye,
  X,
  FileCode,
  ShieldCheck,
  Calendar
} from 'lucide-react';

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [outcomeFilter, setOutcomeFilter] = useState<string>('');
  const [actionFilter, setActionFilter] = useState('');
  const [search, setSearch] = useState('');
  const [targetTypeFilter, setTargetTypeFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail Modal
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [activeLog, setActiveLog] = useState<AuditLogItem | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const fetchLogs = useCallback((
    targetPage = page,
    outcome = outcomeFilter,
    action = actionFilter,
    query = search,
    tType = targetTypeFilter
  ) => {
    setIsLoading(true);
    setError(null);
    adminApi.getAuditLogs({
      page: targetPage,
      limit: 15,
      outcome: (outcome as 'SUCCESS' | 'FAILURE' | 'DENIED') || undefined,
      action: action ? action.trim() : undefined,
      search: query ? query.trim() : undefined,
      targetType: tType ? tType.trim() : undefined
    })
      .then((data) => {
        setLogs(data.logs || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      })
      .catch((err: unknown) => {
        if (err instanceof Error) setError(err.message);
        else setError('Failed to load audit logs.');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [page, outcomeFilter, actionFilter, search, targetTypeFilter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const openLogDetail = async (id: string) => {
    setSelectedLogId(id);
    setIsDetailLoading(true);
    try {
      const res = await adminApi.getAuditLogDetail(id);
      setActiveLog(res.log);
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to load audit record detail');
    } finally {
      setIsDetailLoading(false);
    }
  };

  const closeLogDetail = () => {
    setSelectedLogId(null);
    setActiveLog(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#2E333B]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F4F2ED]">
            Admin Audit Trail
          </h1>
          <p className="text-xs text-[#9CA3AF] mt-0.5">
            Immutable log of all privileged mutations, authorization checks, and security events.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fetchLogs()}
          isLoading={isLoading}
          className="gap-1.5 h-8 text-xs"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh</span>
        </Button>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-between text-xs text-rose-400">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Filter Bar */}
      <Card className="p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            fetchLogs(1, outcomeFilter, actionFilter, search, targetTypeFilter);
          }}
          className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs"
        >
          <Input
            placeholder="Search action or target..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 text-xs"
          />

          <Input
            placeholder="Specific action (e.g. user.ban)..."
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-9 text-xs"
          />

          <select
            value={outcomeFilter}
            onChange={(e) => {
              setOutcomeFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 px-3 bg-[#15181D] border border-[#2E333B] rounded-lg text-xs text-[#F4F2ED] focus:outline-none focus:border-[#E7B24A]"
          >
            <option value="">All Outcomes</option>
            <option value="SUCCESS">SUCCESS only</option>
            <option value="DENIED">DENIED only</option>
            <option value="FAILURE">FAILURE only</option>
          </select>

          <div className="flex items-center justify-end gap-2">
            <Button type="submit" size="sm" variant="secondary" className="h-9 px-4 text-xs gap-1.5">
              <Search className="w-3.5 h-3.5" />
              <span>Filter</span>
            </Button>
          </div>
        </form>
      </Card>

      {/* Logs Table */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#1E2229] text-[#9CA3AF] border-b border-[#2E333B] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Outcome</th>
                <th className="py-3 px-4">Target Type / ID</th>
                <th className="py-3 px-4">Actor</th>
                <th className="py-3 px-4">IP Address</th>
                <th className="py-3 px-4 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2E333B]">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#6B7280]">
                    {isLoading ? 'Loading audit records...' : 'No audit records match query.'}
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-[#1E2229]/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-[#9CA3AF] whitespace-nowrap">
                      {formatDate(log.createdAt)}
                    </td>
                    <td className="py-3 px-4 font-semibold text-[#F4F2ED]">
                      {log.action}
                    </td>
                    <td className="py-3 px-4">
                      <Badge
                        variant={
                          log.outcome === 'SUCCESS'
                            ? 'success'
                            : log.outcome === 'DENIED'
                            ? 'warning'
                            : 'danger'
                        }
                      >
                        {log.outcome}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#9CA3AF]">
                      {log.targetType ? `${log.targetType}:${log.targetId ? log.targetId.slice(0, 8) + '...' : ''}` : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#F4F2ED]">
                      {log.admin?.email || (log.adminId ? `${log.adminId.slice(0, 8)}...` : 'system')}
                    </td>
                    <td className="py-3 px-4 text-[11px] font-mono text-[#6B7280]">
                      {log.ip || '—'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openLogDetail(log.id)}
                        className="h-7 text-[11px] gap-1"
                      >
                        <Eye className="w-3 h-3" />
                        <span>Inspect</span>
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="p-3 bg-[#15181D] border-t border-[#2E333B] flex items-center justify-between text-xs text-[#9CA3AF]">
          <span>
            Total Records: <strong className="font-mono text-[#F4F2ED]">{total}</strong> • Page {page} of {totalPages}
          </span>
          <div className="flex gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </Card>

      {/* ===================== AUDIT LOG DETAIL MODAL ===================== */}
      {selectedLogId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#15181D] border border-[#2E333B] rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 bg-[#1E2229] border-b border-[#2E333B] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#E7B24A]" />
                <h3 className="text-sm font-bold text-[#F4F2ED]">Audit Log Inspection</h3>
              </div>
              <button
                onClick={closeLogDetail}
                className="text-[#9CA3AF] hover:text-[#F4F2ED]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 text-xs text-[#F4F2ED]">
              {isDetailLoading || !activeLog ? (
                <div className="py-12 text-center text-[#9CA3AF]">Loading audit record...</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="p-3 bg-[#0B0D10] border border-[#2E333B] rounded space-y-0.5">
                      <span className="text-[10px] uppercase text-[#9CA3AF] font-semibold">Action</span>
                      <p className="font-bold text-[#F4F2ED]">{activeLog.action}</p>
                    </div>

                    <div className="p-3 bg-[#0B0D10] border border-[#2E333B] rounded space-y-0.5">
                      <span className="text-[10px] uppercase text-[#9CA3AF] font-semibold">Outcome</span>
                      <div>
                        <Badge
                          variant={
                            activeLog.outcome === 'SUCCESS'
                              ? 'success'
                              : activeLog.outcome === 'DENIED'
                              ? 'warning'
                              : 'danger'
                          }
                        >
                          {activeLog.outcome}
                        </Badge>
                      </div>
                    </div>

                    <div className="p-3 bg-[#0B0D10] border border-[#2E333B] rounded space-y-0.5">
                      <span className="text-[10px] uppercase text-[#9CA3AF] font-semibold">Actor</span>
                      <p className="font-mono text-[#F4F2ED]">{activeLog.admin?.email || activeLog.adminId || 'SYSTEM'}</p>
                    </div>

                    <div className="p-3 bg-[#0B0D10] border border-[#2E333B] rounded space-y-0.5">
                      <span className="text-[10px] uppercase text-[#9CA3AF] font-semibold">Recorded At</span>
                      <p className="font-mono text-[#9CA3AF]">{formatDate(activeLog.createdAt)}</p>
                    </div>
                  </div>

                  <div className="p-3 bg-[#0B0D10] border border-[#2E333B] rounded space-y-1">
                    <span className="text-[10px] uppercase text-[#9CA3AF] font-semibold">Network & Request Telemetry</span>
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-[#9CA3AF]">
                      <div>IP Address: <span className="text-[#F4F2ED]">{activeLog.ip || '—'}</span></div>
                      <div>Request ID: <span className="text-[#F4F2ED]">{activeLog.requestId || '—'}</span></div>
                      <div className="col-span-2 truncate">User Agent: <span className="text-[#F4F2ED]">{activeLog.userAgent || '—'}</span></div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-[10px] uppercase font-bold text-[#9CA3AF] flex items-center gap-1">
                      <FileCode className="w-3.5 h-3.5 text-[#E7B24A]" />
                      <span>Full Metadata & State Mutation Payload</span>
                    </span>
                    <pre className="p-3 bg-[#0B0D10] border border-[#2E333B] rounded text-[11px] font-mono text-[#9CA3AF] overflow-x-auto max-h-64">
                      {activeLog.metadata ? JSON.stringify(activeLog.metadata, null, 2) : 'No metadata recorded.'}
                    </pre>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
