'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/client';
import {
  NotificationTemplateItem,
  NotificationCategory,
  NotificationChannel,
  ChannelCapabilityItem,
  NotificationPreviewResult,
  AuditLogItem
} from '@/lib/api/types';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  Bell,
  Search,
  Plus,
  RefreshCw,
  Eye,
  History,
  Edit3,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Radio,
  Code2,
  X
} from 'lucide-react';

const ALL_CATEGORIES: NotificationCategory[] = [
  'TRANSACTIONAL',
  'GAMEPLAY',
  'ACCOUNT',
  'COMPLIANCE',
  'MARKETING_SYSTEM'
];

const ALL_CHANNELS: NotificationChannel[] = ['IN_APP', 'PUSH', 'EMAIL'];

function extractVariablesFromText(text: string): string[] {
  const regex = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,63})\s*\}\}/g;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (!found.includes(match[1])) {
      found.push(match[1]);
    }
  }
  return found;
}

export default function NotificationTemplatesPage() {
  const { user } = useAuth();
  const canRead = canAccessPermission(user, PERMISSIONS.CONFIG_READ);
  const canManage = canAccessPermission(user, PERMISSIONS.TEMPLATES_MANAGE);

  const [templates, setTemplates] = useState<NotificationTemplateItem[]>([]);
  const [channels, setChannels] = useState<ChannelCapabilityItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  // Create / Edit Modal
  const [editorMode, setEditorMode] = useState<'CREATE' | 'EDIT' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplateItem | null>(null);
  const [formCode, setFormCode] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formBody, setFormBody] = useState('');
  const [formCategory, setFormCategory] = useState<NotificationCategory>('TRANSACTIONAL');
  const [formChannels, setFormChannels] = useState<NotificationChannel[]>(['IN_APP']);
  const [formVariables, setFormVariables] = useState<string[]>([]);
  const [formIsActive, setFormIsActive] = useState(true);
  const [formReason, setFormReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Live Preview Modal / Drawer
  const [previewTarget, setPreviewTarget] = useState<{
    mode: 'SAVED' | 'DRAFT';
    code: string;
    title: string;
    bodyTemplate: string;
    variables: string[];
    channels: NotificationChannel[];
    version?: number;
  } | null>(null);
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  const [previewResult, setPreviewResult] = useState<NotificationPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [missingVarsList, setMissingVarsList] = useState<string[]>([]);
  const [isRunningPreview, setIsRunningPreview] = useState(false);

  // Version History Modal
  const [historyTemplate, setHistoryTemplate] = useState<NotificationTemplateItem | null>(null);
  const [historyLogs, setHistoryLogs] = useState<AuditLogItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const loadTemplates = useCallback(async () => {
    setError(null);
    setPermissionDenied(false);
    try {
      const res = await adminApi.getNotificationTemplates();
      setTemplates(res.templates || []);
      setChannels(res.channelCapabilities || []);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.statusCode === 403) {
        setPermissionDenied(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load notification templates');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadTemplates();
    })();
  }, [loadTemplates]);

  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      if (categoryFilter !== 'ALL' && t.category !== categoryFilter) return false;
      if (channelFilter !== 'ALL' && !t.channels.includes(channelFilter as NotificationChannel)) return false;
      if (activeFilter === 'ACTIVE' && !t.isActive) return false;
      if (activeFilter === 'INACTIVE' && t.isActive) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchCode = t.code.toLowerCase().includes(q);
        const matchTitle = t.title.toLowerCase().includes(q);
        const matchBody = t.bodyTemplate.toLowerCase().includes(q);
        return matchCode || matchTitle || matchBody;
      }
      return true;
    });
  }, [templates, categoryFilter, channelFilter, activeFilter, searchQuery]);

  // Automatically sync detected placeholders in Create/Edit modal
  const detectedPlaceholders = useMemo(
    () =>
      Array.from(
        new Set([...extractVariablesFromText(formTitle), ...extractVariablesFromText(formBody)])
      ),
    [formTitle, formBody]
  );

  const syncFormVariablesWithPlaceholders = () => {
    setFormVariables(detectedPlaceholders);
  };

  const openCreateModal = () => {
    setEditorMode('CREATE');
    setEditingTemplate(null);
    setFormCode('');
    setFormTitle('');
    setFormBody('');
    setFormCategory('TRANSACTIONAL');
    setFormChannels(['IN_APP']);
    setFormVariables([]);
    setFormIsActive(true);
    setFormReason('');
  };

  const openEditModal = (tpl: NotificationTemplateItem) => {
    setEditorMode('EDIT');
    setEditingTemplate(tpl);
    setFormCode(tpl.code);
    setFormTitle(tpl.title);
    setFormBody(tpl.bodyTemplate);
    setFormCategory(tpl.category);
    setFormChannels(tpl.channels || ['IN_APP']);
    setFormVariables(tpl.variables || []);
    setFormIsActive(tpl.isActive);
    setFormReason('');
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'A change reason of at least 5 characters is required.'
      });
      return;
    }

    setIsSaving(true);
    setBanner(null);
    try {
      const varsToSave =
        formVariables.length > 0 ? formVariables : detectedPlaceholders;

      if (editorMode === 'CREATE') {
        const res = await adminApi.createNotificationTemplate({
          code: formCode.trim().toUpperCase(),
          title: formTitle.trim(),
          bodyTemplate: formBody.trim(),
          category: formCategory,
          channels: formChannels,
          variables: varsToSave,
          isActive: formIsActive,
          changeReason: formReason.trim()
        });
        setBanner({
          type: 'success',
          message: `Template '${res.template.code}' created at v${res.template.version}.`
        });
      } else if (editorMode === 'EDIT' && editingTemplate) {
        const res = await adminApi.updateNotificationTemplate(editingTemplate.code, {
          title: formTitle.trim(),
          bodyTemplate: formBody.trim(),
          category: formCategory,
          channels: formChannels,
          variables: varsToSave,
          isActive: formIsActive,
          changeReason: formReason.trim()
        });
        setBanner({
          type: 'success',
          message: `Template '${res.template.code}' updated to v${res.template.version}.`
        });
      }

      setEditorMode(null);
      await loadTemplates();
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save notification template'
      });
    } finally {
      setIsSaving(false);
    }
  };

  const openPreviewForSaved = (tpl: NotificationTemplateItem) => {
    const initialSamples: Record<string, string> = {};
    for (const v of tpl.variables) {
      if (v.toLowerCase().includes('amount') || v.toLowerCase().includes('payout') || v.toLowerCase().includes('stake')) {
        initialSamples[v] = '₦15,000.00';
      } else if (v.toLowerCase().includes('match')) {
        initialSamples[v] = 'm-84920a1b';
      } else if (v.toLowerCase().includes('reason')) {
        initialSamples[v] = 'Bank account name mismatch';
      } else if (v.toLowerCase().includes('grace')) {
        initialSamples[v] = '30';
      } else {
        initialSamples[v] = `Sample_${v}`;
      }
    }

    setPreviewTarget({
      mode: 'SAVED',
      code: tpl.code,
      title: tpl.title,
      bodyTemplate: tpl.bodyTemplate,
      variables: tpl.variables,
      channels: tpl.channels,
      version: tpl.version
    });
    setSampleValues(initialSamples);
    setPreviewResult(null);
    setPreviewError(null);
    setMissingVarsList([]);
  };

  const handleRunPreview = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!previewTarget) return;

    setIsRunningPreview(true);
    setPreviewError(null);
    setMissingVarsList([]);
    try {
      if (previewTarget.mode === 'SAVED') {
        const res = await adminApi.previewSavedNotificationTemplate(
          previewTarget.code,
          sampleValues
        );
        setPreviewResult(res.preview);
      } else {
        const res = await adminApi.previewDraftNotificationTemplate({
          code: previewTarget.code || null,
          title: previewTarget.title,
          bodyTemplate: previewTarget.bodyTemplate,
          variables: previewTarget.variables,
          channels: previewTarget.channels,
          sampleValues
        });
        setPreviewResult(res.preview);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setPreviewError(err.message);
        const missing = (err.data as { missingVariables?: string[] })?.missingVariables;
        if (Array.isArray(missing)) {
          setMissingVarsList(missing);
        }
      } else {
        setPreviewError(err instanceof Error ? err.message : 'Preview rendering failed');
      }
      setPreviewResult(null);
    } finally {
      setIsRunningPreview(false);
    }
  };

  const handleOpenHistory = async (tpl: NotificationTemplateItem) => {
    setHistoryTemplate(tpl);
    setIsLoadingHistory(true);
    try {
      const res = await adminApi.getNotificationTemplateHistory(tpl.code, { page: 1, limit: 25 });
      setHistoryLogs(res.history || []);
    } catch {
      setHistoryLogs([]);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const toggleChannel = (ch: NotificationChannel) => {
    setFormChannels((prev) => {
      if (prev.includes(ch)) {
        return prev.length > 1 ? prev.filter((c) => c !== ch) : prev;
      }
      return [...prev, ch];
    });
  };

  if (permissionDenied || (!canRead && !isLoading)) {
    return (
      <Card className="p-8 border-amber-500/30">
        <div className="flex items-start gap-4">
          <Lock className="w-6 h-6 text-amber-400 shrink-0" />
          <div className="space-y-2">
            <h2 className="text-base font-bold text-[#F5F7FA]">
              Configuration Read Permission Required (`config.read`)
            </h2>
            <p className="text-xs text-[#8FA3B7]">
              Inspecting notification templates requires <code className="font-mono text-[#18C986]">config.read</code>.
              Creating or editing templates requires <code className="font-mono text-[#18C986]">templates.manage</code>.
            </p>
            <div className="flex gap-2 pt-2">
              <Link href="/configuration/feature-flags">
                <Button variant="secondary" size="sm">Open Feature Flags</Button>
              </Link>
              <Link href="/configuration/maintenance">
                <Button variant="secondary" size="sm">Open Maintenance Controls</Button>
              </Link>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Channel Capability Status Cards (Honest Runtime Implementation Indicators) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(channels.length > 0
          ? channels
          : [
              {
                channel: 'IN_APP' as const,
                implemented: true,
                deliveryMode: 'POSTGRES_AND_SOCKET_OUTBOX',
                description:
                  'Persisted to PostgreSQL Notification table and delivered in real time via Socket.IO outbox drainer'
              },
              {
                channel: 'PUSH' as const,
                implemented: false,
                deliveryMode: 'MOCK_FCM_FALLBACK',
                description:
                  'Outbox drainer logs offline push fallback ([MOCK FCM]); external FCM provider SDK is not wired'
              },
              {
                channel: 'EMAIL' as const,
                implemented: false,
                deliveryMode: 'TEMPLATE_ONLY',
                description:
                  'Supported in template schema and preview; no external email delivery provider is implemented in repository'
              }
            ]
        ).map((cap) => (
          <Card key={cap.channel} className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono text-xs font-bold text-[#F5F7FA]">
                <Radio className="w-4 h-4 text-[#18C986]" />
                <span>{cap.channel} Channel</span>
              </div>
              {cap.implemented ? (
                <Badge variant="success">Implemented (Live)</Badge>
              ) : cap.deliveryMode === 'MOCK_FCM_FALLBACK' ? (
                <Badge variant="warning">Mock Fallback Only</Badge>
              ) : (
                <Badge variant="default">Template-Only (No Provider)</Badge>
              )}
            </div>
            <div className="font-mono text-[10px] text-[#18C986]">{cap.deliveryMode}</div>
            <p className="text-[11px] text-[#8FA3B7]">{cap.description}</p>
          </Card>
        ))}
      </div>

      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#0C1B2A] border border-[#274056] rounded-xl p-4">
        <div className="space-y-0.5 text-xs">
          <div className="font-bold text-[#F5F7FA]">
            Versioned Transactional &amp; Operational Notification Templates
          </div>
          <p className="text-[#8FA3B7]">
            All templates enforce balanced <code className="font-mono">{'{{variable}}'}</code> placeholders, reject raw
            HTML/scripts, and block predatory loss-chasing phrases.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setIsLoading(true);
              void loadTemplates();
            }}
            isLoading={isLoading}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
          {canManage && (
            <Button variant="primary" size="sm" onClick={openCreateModal}>
              <Plus className="w-3.5 h-3.5" />
              New Template
            </Button>
          )}
        </div>
      </div>

      {banner && (
        <div
          role="status"
          className={`rounded-xl p-4 border flex items-center justify-between text-xs ${
            banner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {banner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <AlertTriangle className="w-4 h-4" />
            )}
            <span>{banner.message}</span>
          </div>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search & Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-[#53677A] absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search code, title, or body template…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-9 pl-9 pr-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA] placeholder-[#53677A]"
            />
          </div>

          <select
            aria-label="Filter notification templates by category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
          >
            <option value="ALL">All Categories</option>
            {ALL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter notification templates by channel"
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
          >
            <option value="ALL">All Channels</option>
            {ALL_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>
                {ch}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter notification templates by active state"
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}
            className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
          >
            <option value="ALL">All States</option>
            <option value="ACTIVE">Active Templates Only</option>
            <option value="INACTIVE">Inactive Templates Only</option>
          </select>
        </div>
      </Card>

      {/* Templates Table */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Notification Template Directory ({filteredTemplates.length})</CardTitle>
            <CardDescription>
              Sequential template versioning, required variable schemas, and server-side preview verification.
            </CardDescription>
          </div>
        </CardHeader>

        {error ? (
          <div className="py-8 text-center text-xs text-rose-400">{error}</div>
        ) : isLoading ? (
          <div className="py-10 text-center text-xs text-[#8FA3B7]">Loading notification templates…</div>
        ) : filteredTemplates.length === 0 ? (
          <div className="py-10 text-center text-xs text-[#53677A]">
            No notification templates found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#274056] text-[10px] font-bold uppercase tracking-wider text-[#53677A]">
                  <th className="py-3 px-4">Code &amp; Version</th>
                  <th className="py-3 px-4">Title &amp; Body Template</th>
                  <th className="py-3 px-4">Category &amp; Channels</th>
                  <th className="py-3 px-4">Declared Variables</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#274056] text-xs">
                {filteredTemplates.map((tpl) => (
                  <tr key={tpl.id || tpl.code} className="hover:bg-[#132638]/60">
                    <td className="py-3.5 px-4 align-top">
                      <div className="font-mono font-bold text-[#F5F7FA]">{tpl.code}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Badge variant="gold">v{tpl.version}</Badge>
                      </div>
                      <div className="font-mono text-[10px] text-[#53677A] mt-1">
                        {formatDate(tpl.updatedAt)}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top max-w-md">
                      <div className="font-semibold text-[#F5F7FA]">{tpl.title}</div>
                      <div className="font-mono text-[11px] text-[#8FA3B7] mt-1 bg-[#000000] border border-[#274056] rounded p-2">
                        {tpl.bodyTemplate}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      <Badge variant="default">{tpl.category}</Badge>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {tpl.channels.map((ch) => {
                          const isImpl = ch === 'IN_APP';
                          return (
                            <span
                              key={ch}
                              title={
                                isImpl
                                  ? 'Implemented (Postgres + Socket.IO Outbox)'
                                  : ch === 'PUSH'
                                    ? 'Mock FCM Fallback Only'
                                    : 'Template Only (No External Email Provider)'
                              }
                              className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                                isImpl
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                  : 'bg-[#000000] text-[#8FA3B7] border-[#274056]'
                              }`}
                            >
                              {ch} {isImpl ? '✓' : '(stub)'}
                            </span>
                          );
                        })}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      {tpl.variables.length === 0 ? (
                        <span className="text-[#53677A]">None</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {tpl.variables.map((v) => {
                            const isSysReq = tpl.systemRequiredVariables?.includes(v);
                            return (
                              <span
                                key={v}
                                className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                                  isSysReq
                                    ? 'bg-[#0E2E2B] text-[#18C986] border-[#18C986]/40'
                                    : 'bg-[#000000] text-[#F5F7FA] border-[#274056]'
                                }`}
                              >
                                {`{{${v}}}`}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      {tpl.isActive ? (
                        <Badge variant="success">ACTIVE</Badge>
                      ) : (
                        <Badge variant="default">INACTIVE</Badge>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openPreviewForSaved(tpl)}
                        >
                          <Eye className="w-3.5 h-3.5 text-[#18C986]" />
                          Preview
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenHistory(tpl)}
                        >
                          <History className="w-3.5 h-3.5" />
                          History
                        </Button>

                        {canManage && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditModal(tpl)}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            Edit
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create / Edit Template Modal */}
      {editorMode && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <form
            onSubmit={handleSaveTemplate}
            className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#274056] pb-3">
              <div>
                <h3 className="text-base font-bold text-[#F5F7FA]">
                  {editorMode === 'CREATE'
                    ? 'Create Notification Template (v1)'
                    : `Edit Template: ${editingTemplate?.code} (v${editingTemplate?.version} → v${
                        (editingTemplate?.version ?? 1) + 1
                      })`}
                </h3>
                <p className="text-xs text-[#8FA3B7]">
                  Placeholders must use <code className="font-mono">{'{{variableName}}'}</code> syntax and match declared variables.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditorMode(null)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Template Code (`code`)"
                value={formCode}
                disabled={editorMode === 'EDIT'}
                onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                placeholder="e.g., DEPOSIT_CONFIRMED"
                helperText="UPPERCASE_SNAKE_CASE identifier"
              />

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                  Category (`category`)
                </label>
                <select
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value as NotificationCategory)}
                  className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
                >
                  {ALL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <Input
              label="Notification Title (`title`)"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              placeholder="e.g., Deposit of {{amount}} Confirmed"
            />

            <div className="space-y-1.5">
              <label
                htmlFor="tpl-body-textarea"
                className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]"
              >
                Body Template (`bodyTemplate` — No raw HTML or scripts allowed)
              </label>
              <textarea
                id="tpl-body-textarea"
                rows={3}
                value={formBody}
                onChange={(e) => setFormBody(e.target.value)}
                placeholder="Your deposit of {{amount}} has been credited to your available balance."
                className="w-full p-3 bg-[#000000] border border-[#274056] rounded-lg font-mono text-xs text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
              />
            </div>

            {/* Detected Variables & Sync */}
            <div className="bg-[#000000] border border-[#274056] rounded-xl p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#F5F7FA] flex items-center gap-1.5">
                  <Code2 className="w-4 h-4 text-[#18C986]" />
                  <span>Detected Placeholders:</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={syncFormVariablesWithPlaceholders}
                >
                  Sync Declared Variables ({detectedPlaceholders.length})
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {detectedPlaceholders.length === 0 ? (
                  <span className="text-[#53677A]">No `{'{{variable}}'}` placeholders detected in title or body.</span>
                ) : (
                  detectedPlaceholders.map((v) => (
                    <Badge key={v} variant="gold">
                      {`{{${v}}}`}
                    </Badge>
                  ))
                )}
              </div>
            </div>

            {/* Channels */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                Target Channels (`channels`)
              </label>
              <div className="flex flex-wrap gap-2">
                {ALL_CHANNELS.map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => toggleChannel(ch)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono border ${
                      formChannels.includes(ch)
                        ? 'bg-[#0E2E2B] text-[#18C986] border-[#18C986]/50 font-bold'
                        : 'bg-[#000000] text-[#8FA3B7] border-[#274056]'
                    }`}
                  >
                    {ch} {ch === 'IN_APP' ? '(Live)' : ch === 'PUSH' ? '(Mock Fallback)' : '(Template Only)'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-[#F5F7FA] cursor-pointer">
                <input
                  type="checkbox"
                  checked={formIsActive}
                  onChange={(e) => setFormIsActive(e.target.checked)}
                  className="rounded border-[#274056] bg-[#000000]"
                />
                <span>Template is Active (`isActive: true`)</span>
              </label>
            </div>

            <Input
              label="Mandatory Audit Change Reason (Min 5 Characters)"
              value={formReason}
              onChange={(e) => setFormReason(e.target.value)}
              placeholder="Explain why this template is being created or updated"
            />

            <div className="flex justify-between items-center pt-3 border-t border-[#274056]">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  const vars = formVariables.length > 0 ? formVariables : detectedPlaceholders;
                  const samples: Record<string, string> = {};
                  for (const v of vars) samples[v] = `Sample_${v}`;
                  setPreviewTarget({
                    mode: 'DRAFT',
                    code: formCode || 'DRAFT_PREVIEW',
                    title: formTitle,
                    bodyTemplate: formBody,
                    variables: vars,
                    channels: formChannels
                  });
                  setSampleValues(samples);
                  setPreviewResult(null);
                  setPreviewError(null);
                }}
              >
                <Eye className="w-3.5 h-3.5 text-[#18C986]" />
                Test Draft Preview
              </Button>

              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" type="button" onClick={() => setEditorMode(null)}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" type="submit" isLoading={isSaving}>
                  {editorMode === 'CREATE' ? 'Create Template' : 'Save New Version'}
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Server-Backed Template Preview Modal */}
      {previewTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#274056] pb-3">
              <div>
                <h3 className="text-base font-bold text-[#F5F7FA]">
                  Server-Rendered Notification Preview:{' '}
                  <span className="font-mono text-[#18C986]">{previewTarget.code}</span>
                </h3>
                <p className="text-xs text-[#8FA3B7]">
                  Validated and rendered via <code className="font-mono">POST /admin/notification-templates/preview</code>.
                  Untrusted HTML is escaped server-side and rendered strictly as plain text.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewTarget(null)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleRunPreview} className="space-y-4">
              {previewTarget.variables.length === 0 ? (
                <p className="text-xs text-[#8FA3B7]">This template has no required variables.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {previewTarget.variables.map((varName) => (
                    <Input
                      key={varName}
                      label={`Variable: {{${varName}}}`}
                      value={sampleValues[varName] ?? ''}
                      error={missingVarsList.includes(varName) ? 'Required variable missing' : undefined}
                      onChange={(e) =>
                        setSampleValues((prev) => ({
                          ...prev,
                          [varName]: e.target.value
                        }))
                      }
                      placeholder={`Enter sample value for ${varName}`}
                    />
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="sm" isLoading={isRunningPreview}>
                  <Bell className="w-3.5 h-3.5" />
                  Render Server Preview
                </Button>
              </div>
            </form>

            {previewError && (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3.5 text-xs text-rose-300 space-y-1">
                <div className="font-bold flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Template Preview Validation Error:</span>
                </div>
                <p>{previewError}</p>
                {missingVarsList.length > 0 && (
                  <p className="font-mono text-[11px]">
                    Missing required variable(s): {missingVarsList.join(', ')}
                  </p>
                )}
              </div>
            )}

            {previewResult && (
              <div className="bg-[#000000] border border-emerald-500/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                    Rendered Output (Escaped &amp; Validated)
                  </span>
                  {previewResult.version && <Badge variant="gold">v{previewResult.version}</Badge>}
                </div>

                <div className="bg-[#0C1B2A] border border-[#274056] rounded-lg p-3.5 space-y-1.5">
                  <div className="text-sm font-bold text-[#F5F7FA]">{previewResult.renderedTitle}</div>
                  <div className="text-xs text-[#8FA3B7] whitespace-pre-wrap">
                    {previewResult.renderedBody}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8FA3B7]">
                  <span>
                    Used Variables: <code className="font-mono text-[#F5F7FA]">{previewResult.usedVariables.join(', ') || 'None'}</code>
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {previewResult.channelDetails.map((ch) => (
                      <Badge
                        key={ch.channel}
                        variant={ch.implemented ? 'success' : 'default'}
                      >
                        {ch.channel}: {ch.deliveryMode}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Template Version & Audit History Modal */}
      {historyTemplate && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#274056] pb-3">
              <div>
                <h3 className="text-base font-bold text-[#F5F7FA]">
                  Template Version &amp; Audit History:{' '}
                  <span className="font-mono text-[#18C986]">{historyTemplate.code}</span> (Current: v
                  {historyTemplate.version})
                </h3>
                <p className="text-xs text-[#8FA3B7]">
                  Every template modification increments its version number and records before/after snapshots.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryTemplate(null)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 space-y-3">
              {isLoadingHistory ? (
                <div className="py-8 text-center text-xs text-[#8FA3B7]">Loading template history…</div>
              ) : historyLogs.length === 0 ? (
                <div className="py-8 text-center text-xs text-[#53677A]">
                  No audit records found for this template.
                </div>
              ) : (
                historyLogs.map((log) => (
                  <div
                    key={log.id}
                    className="bg-[#000000] border border-[#274056] rounded-xl p-3.5 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-[#18C986]">{log.action}</span>
                      <span className="font-mono text-[11px] text-[#8FA3B7]">
                        {formatDate(log.createdAt)}
                      </span>
                    </div>
                    <div className="text-[#8FA3B7]">
                      Actor: <span className="font-mono text-[#F5F7FA]">{log.adminId}</span>
                    </div>
                    {log.metadata && (
                      <pre className="bg-[#0C1B2A] border border-[#274056] rounded-lg p-2.5 font-mono text-[11px] text-[#8FA3B7] overflow-x-auto">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
