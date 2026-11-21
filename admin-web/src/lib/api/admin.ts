import { apiClient } from './client';
import type {
  AuditLogItem,
  PaginatedResponse,
  WithdrawalItem,
  VerificationCaseItem,
  VerificationDocumentAccessResponse,
  DisputeItem,
  RiskEventItem,
  RiskCaseItem,
  SaferPlayRestrictionItem,
  MatchListItem,
  MatchDetailResponse,
  SupportCaseItem,
  SystemHealthResponse,
  DashboardSummaryResponse,
  PlayerListItem,
  PlayerDetailResponse,
  PlatformConfigPayload,
  PlatformConfigVersionItem,
  ConfigVersionStatus,
  ConfigVersionHistoryResponse,
  ValidateConfigDraftResponse,
  ConfigApprovalItem,
  FeatureFlagItem,
  FeatureFlagEvaluation,
  FeatureFlagHistoryResponse,
  PlayerTier,
  NotificationTemplateItem,
  NotificationCategory,
  NotificationChannel,
  ChannelCapabilityItem,
  NotificationPreviewResult,
  NotificationTemplateHistoryResponse,
  MaintenanceStateItem,
  MaintenanceScope,
  MaintenanceAccessDecision,
  MaintenanceHistoryResponse,
  AdminNotificationsResponse,
  AdminDepositsResponse,
  AdminLedgerTransactionsResponse,
  SimulationStatusSnapshot
} from './types';
import type { AdminRole } from '../permissions/roles';

export const adminApi = {
  // Dashboard Summary (Module A)
  async getDashboardSummary(): Promise<{ summary: DashboardSummaryResponse }> {
    return apiClient.get<{ summary: DashboardSummaryResponse }>('/admin/dashboard/summary');
  },

  // Audit Logs (AUDIT_READ)
  async getAuditLogs(params: {
    page?: number;
    limit?: number;
    outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
    action?: string;
    adminId?: string;
    targetId?: string;
    targetType?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  } = {}): Promise<PaginatedResponse<AuditLogItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.outcome) q.set('outcome', params.outcome);
    if (params.action) q.set('action', params.action);
    if (params.adminId) q.set('adminId', params.adminId);
    if (params.targetId) q.set('targetId', params.targetId);
    if (params.targetType) q.set('targetType', params.targetType);
    if (params.search) q.set('search', params.search);
    if (params.dateFrom) q.set('dateFrom', params.dateFrom);
    if (params.dateTo) q.set('dateTo', params.dateTo);
    return apiClient.get<PaginatedResponse<AuditLogItem>>(`/admin/audit/logs?${q.toString()}`);
  },

  async getAuditLogDetail(id: string): Promise<{ log: AuditLogItem }> {
    return apiClient.get<{ log: AuditLogItem }>(`/admin/audit/logs/${id}`);
  },

  // User Management (Module B)
  async getUsers(params: {
    page?: number;
    limit?: number;
    search?: string;
    isBanned?: boolean;
    kycStatus?: string;
    dateFrom?: string;
    dateTo?: string;
    sortBy?: string;
    order?: 'asc' | 'desc';
  } = {}): Promise<PaginatedResponse<PlayerListItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.search) q.set('search', params.search);
    if (typeof params.isBanned === 'boolean') q.set('isBanned', params.isBanned.toString());
    if (params.kycStatus) q.set('kycStatus', params.kycStatus);
    if (params.dateFrom) q.set('dateFrom', params.dateFrom);
    if (params.dateTo) q.set('dateTo', params.dateTo);
    if (params.sortBy) q.set('sortBy', params.sortBy);
    if (params.order) q.set('order', params.order);
    return apiClient.get<PaginatedResponse<PlayerListItem>>(`/admin/users?${q.toString()}`);
  },

  async getUserDetail(userId: string): Promise<PlayerDetailResponse> {
    return apiClient.get<PlayerDetailResponse>(`/admin/users/${userId}`);
  },

  async banUser(userId: string): Promise<{ user: unknown; message: string }> {
    return apiClient.patch<{ user: unknown; message: string }>(`/admin/users/${userId}/ban`);
  },

  async unbanUser(userId: string): Promise<{ user: unknown; message: string }> {
    return apiClient.patch<{ user: unknown; message: string }>(`/admin/users/${userId}/unban`);
  },

  // Withdrawals (WITHDRAWALS_READ / WITHDRAWALS_PROCESS)
  async getWithdrawals(params: {
    page?: number;
    limit?: number;
    status?: string;
  } = {}): Promise<PaginatedResponse<WithdrawalItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    return apiClient.get<PaginatedResponse<WithdrawalItem>>(`/admin/withdrawals?${q.toString()}`);
  },

  async getWithdrawal(id: string): Promise<{ withdrawal: WithdrawalItem & { auditHistory?: AuditLogItem[] } }> {
    return apiClient.get<{ withdrawal: WithdrawalItem & { auditHistory?: AuditLogItem[] } }>(`/admin/withdrawals/${id}`);
  },

  async approveWithdrawal(id: string): Promise<{ withdrawal: WithdrawalItem }> {
    return apiClient.post<{ withdrawal: WithdrawalItem }>(`/admin/withdrawals/${id}/approve`);
  },

  async beginWithdrawalPayout(id: string): Promise<{ withdrawal: WithdrawalItem }> {
    return apiClient.post<{ withdrawal: WithdrawalItem }>(`/admin/withdrawals/${id}/begin-payout`);
  },

  async reportWithdrawalResult(id: string, payload: { success: boolean; failureReason?: string }): Promise<{ withdrawal: WithdrawalItem }> {
    return apiClient.post<{ withdrawal: WithdrawalItem }>(`/admin/withdrawals/${id}/report-result`, payload);
  },

  async rejectWithdrawal(id: string, reason?: string): Promise<{ withdrawal: WithdrawalItem }> {
    return apiClient.post<{ withdrawal: WithdrawalItem }>(`/admin/withdrawals/${id}/reject`, { reason });
  },

  // Ledger Adjustment (LEDGER_ADJUST)
  async postAdjustment(payload: {
    userId: string;
    amountMinorUnits: string;
    direction: 'CREDIT' | 'DEBIT';
    reason?: string;
    reference: string;
  }): Promise<{ adjustment: { transactionId: string; reference: string; direction: string; available: string } }> {
    return apiClient.post('/admin/ledger/adjustments', payload);
  },

  // Verification / KYC (VERIFICATION_REVIEW)
  async getVerificationCases(params: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
    sortBy?: string;
    order?: 'asc' | 'desc';
  } = {}): Promise<PaginatedResponse<VerificationCaseItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    if (params.search) q.set('search', params.search);
    if (params.sortBy) q.set('sortBy', params.sortBy);
    if (params.order) q.set('order', params.order);
    return apiClient.get<PaginatedResponse<VerificationCaseItem>>(`/admin/verification-cases?${q.toString()}`);
  },

  async getVerificationCaseDetail(id: string): Promise<{ verificationCase: VerificationCaseItem }> {
    return apiClient.get<{ verificationCase: VerificationCaseItem }>(`/admin/verification-cases/${id}`);
  },

  async getVerificationDocumentAccess(id: string, checkId?: string): Promise<{ documentAccess: VerificationDocumentAccessResponse }> {
    return apiClient.post<{ documentAccess: VerificationDocumentAccessResponse }>(
      `/admin/verification-cases/${id}/documents/signed-access`,
      checkId ? { checkId } : {}
    );
  },

  async requestAdditionalKycInfo(id: string, reason: string): Promise<{ verificationCase: VerificationCaseItem; replayed: boolean }> {
    return apiClient.post(`/admin/verification-cases/${id}/request-info`, { reason });
  },

  async approveVerificationCase(id: string, note?: string): Promise<{ verificationCase: VerificationCaseItem; replayed: boolean }> {
    return apiClient.post(`/admin/verification-cases/${id}/approve`, { note });
  },

  async rejectVerificationCase(id: string, reason?: string): Promise<{ verificationCase: VerificationCaseItem; replayed: boolean }> {
    return apiClient.post(`/admin/verification-cases/${id}/reject`, { reason });
  },

  // Disputes (DISPUTES_MANAGE)
  async getDisputes(params: {
    page?: number;
    limit?: number;
    status?: string;
  } = {}): Promise<PaginatedResponse<DisputeItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    return apiClient.get<PaginatedResponse<DisputeItem>>(`/admin/disputes?${q.toString()}`);
  },

  async getDisputeDetail(id: string): Promise<{ disputeCase: DisputeItem }> {
    return apiClient.get<{ disputeCase: DisputeItem }>(`/admin/disputes/${id}`);
  },

  async decideDispute(id: string, status: 'RESOLVED' | 'DISMISSED', resolution: string): Promise<{ disputeCase: DisputeItem }> {
    return apiClient.post(`/admin/disputes/${id}/decide`, { status, resolution });
  },

  async addDisputeEvidence(id: string, evidence: { type: string; url: string; description?: string }): Promise<unknown> {
    return apiClient.post(`/admin/disputes/${id}/evidence`, evidence);
  },

  // Match Operations (MATCHES_READ)
  async getMatches(params: {
    page?: number;
    limit?: number;
    status?: string;
    tier?: string;
    userId?: string;
  } = {}): Promise<PaginatedResponse<MatchListItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    if (params.tier) q.set('tier', params.tier);
    if (params.userId) q.set('userId', params.userId);
    return apiClient.get<PaginatedResponse<MatchListItem>>(`/admin/matches?${q.toString()}`);
  },

  async getMatchDetail(id: string): Promise<MatchDetailResponse> {
    return apiClient.get<MatchDetailResponse>(`/admin/matches/${id}`);
  },

  // Risk Review (RISK_REVIEW)
  async getRiskEvents(params: {
    page?: number;
    limit?: number;
    type?: string;
    severity?: string;
    userId?: string;
  } = {}): Promise<PaginatedResponse<RiskEventItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.type) q.set('type', params.type);
    if (params.severity) q.set('severity', params.severity);
    if (params.userId) q.set('userId', params.userId);
    return apiClient.get<PaginatedResponse<RiskEventItem>>(`/admin/risk-events?${q.toString()}`);
  },

  async getRiskCases(params: {
    page?: number;
    limit?: number;
    status?: string;
  } = {}): Promise<PaginatedResponse<RiskCaseItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    return apiClient.get<PaginatedResponse<RiskCaseItem>>(`/admin/risk-cases?${q.toString()}`);
  },

  async getRiskCaseDetail(id: string): Promise<{ riskCase: RiskCaseItem }> {
    return apiClient.get<{ riskCase: RiskCaseItem }>(`/admin/risk-cases/${id}`);
  },

  async addRiskCaseNote(id: string, payload: {
    note: string;
    actionType?: string;
    status?: 'OPEN' | 'INVESTIGATING' | 'ESCALATED' | 'RESOLVED' | 'DISMISSED';
    assignedTo?: string | null;
  }): Promise<{ riskCase: RiskCaseItem }> {
    return apiClient.post<{ riskCase: RiskCaseItem }>(`/admin/risk-cases/${id}/notes`, payload);
  },

  // Safer Play Restrictions (SAFER_PLAY_LIFT / RISK_REVIEW)
  async getSaferPlayRestrictions(params: {
    page?: number;
    limit?: number;
    search?: string;
    type?: 'timeout' | 'exclusion' | 'limits' | 'all';
  } = {}): Promise<PaginatedResponse<SaferPlayRestrictionItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.search) q.set('search', params.search);
    if (params.type) q.set('type', params.type);
    return apiClient.get<PaginatedResponse<SaferPlayRestrictionItem>>(`/admin/safer-play/restrictions?${q.toString()}`);
  },

  async applySaferPlayRestriction(userId: string, payload: {
    timeoutUntil?: string;
    selfExcludedUntil?: string;
    depositLimitMinorUnits?: string;
    stakeLimitMinorUnits?: string;
    reason?: string;
  }): Promise<{ profile: unknown; message: string }> {
    return apiClient.post<{ profile: unknown; message: string }>(`/admin/users/${userId}/restrictions`, payload);
  },

  async clearTimeout(userId: string): Promise<{ lifted: boolean; profile: unknown }> {
    return apiClient.post(`/admin/safer-play/${userId}/clear-timeout`);
  },

  async endSelfExclusion(userId: string): Promise<{ lifted: boolean; profile: unknown }> {
    return apiClient.post(`/admin/safer-play/${userId}/end-self-exclusion`);
  },

  // Support Operations (SUPPORT_MANAGE)
  async getSupportCases(params: {
    page?: number;
    limit?: number;
    status?: string;
    priority?: string;
    category?: string;
    search?: string;
  } = {}): Promise<PaginatedResponse<SupportCaseItem>> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    if (params.priority) q.set('priority', params.priority);
    if (params.category) q.set('category', params.category);
    if (params.search) q.set('search', params.search);
    return apiClient.get<PaginatedResponse<SupportCaseItem>>(`/admin/support/cases?${q.toString()}`);
  },

  async getSupportCaseDetail(id: string): Promise<{ supportCase: SupportCaseItem }> {
    return apiClient.get<{ supportCase: SupportCaseItem }>(`/admin/support/cases/${id}`);
  },

  async createSupportCase(payload: {
    userId: string;
    subject: string;
    description: string;
    category?: string;
    priority?: string;
    relatedMatchId?: string;
    relatedTransactionRef?: string;
  }): Promise<{ supportCase: SupportCaseItem }> {
    return apiClient.post<{ supportCase: SupportCaseItem }>('/admin/support/cases', payload);
  },

  async updateSupportCase(id: string, payload: {
    status?: string;
    priority?: string;
    assignedTo?: string | null;
    note?: string;
    resolutionNote?: string;
  }): Promise<{ supportCase: SupportCaseItem }> {
    return apiClient.patch<{ supportCase: SupportCaseItem }>(`/admin/support/cases/${id}`, payload);
  },

  // System Health (SYSTEM_HEALTH_READ)
  async getSystemHealth(): Promise<SystemHealthResponse> {
    return apiClient.get<SystemHealthResponse>('/admin/system/health');
  },

  // Roles & Permissions (ROLES_ADMIN - SUPER_ADMIN)
  async getRoles(): Promise<{ roles: Array<{ name: string; description: string; permissions: string[]; assignedCount: number }> }> {
    return apiClient.get('/admin/roles');
  },

  async getUserRoles(userId: string): Promise<{ userId: string; roles: Array<{ name: string; assignedAt: string }> }> {
    return apiClient.get(`/admin/users/${userId}/roles`);
  },

  async assignRole(userId: string, roleName: string): Promise<unknown> {
    return apiClient.post('/admin/roles/assign', { userId, roleName });
  },

  async revokeRole(userId: string, roleName: string): Promise<unknown> {
    return apiClient.post('/admin/roles/revoke', { userId, roleName });
  },

  // ==========================================================================
  // Phase 4: Platform Configuration Versioning & Maker-Checker Governance
  // ==========================================================================
  async getActiveConfig(): Promise<{ config: PlatformConfigVersionItem }> {
    return apiClient.get<{ config: PlatformConfigVersionItem }>('/admin/config/active');
  },

  async getConfigVersions(params: {
    page?: number;
    limit?: number;
    status?: ConfigVersionStatus | '';
  } = {}): Promise<ConfigVersionHistoryResponse> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    return apiClient.get<ConfigVersionHistoryResponse>(`/admin/config/versions?${q.toString()}`);
  },

  async getConfigVersion(versionOrId: number | string): Promise<{ version: PlatformConfigVersionItem }> {
    return apiClient.get<{ version: PlatformConfigVersionItem }>(`/admin/config/versions/${versionOrId}`);
  },

  async validateConfigDraft(
    payload: PlatformConfigPayload,
    baseVersion?: number | null
  ): Promise<ValidateConfigDraftResponse> {
    return apiClient.post<ValidateConfigDraftResponse>('/admin/config/drafts/validate', {
      payload,
      ...(baseVersion ? { baseVersion } : {})
    });
  },

  async createConfigDraft(data: {
    changeReason: string;
    baseVersion?: number | null;
    payload?: PlatformConfigPayload;
    effectiveFrom?: string | null;
  }): Promise<{ draft: PlatformConfigVersionItem }> {
    return apiClient.post<{ draft: PlatformConfigVersionItem }>('/admin/config/drafts', data);
  },

  async updateConfigDraft(
    draftId: string,
    data: {
      payload?: Partial<PlatformConfigPayload>;
      changeReason?: string;
      effectiveFrom?: string | null;
    }
  ): Promise<{ draft: PlatformConfigVersionItem }> {
    return apiClient.patch<{ draft: PlatformConfigVersionItem }>(`/admin/config/drafts/${draftId}`, data);
  },

  async deleteConfigDraft(draftId: string): Promise<{ deleted: boolean; draftId: string; version: number }> {
    return apiClient.delete<{ deleted: boolean; draftId: string; version: number }>(
      `/admin/config/drafts/${draftId}`
    );
  },

  async submitConfigDraft(draftId: string): Promise<{ version: PlatformConfigVersionItem }> {
    return apiClient.post<{ version: PlatformConfigVersionItem }>(
      `/admin/config/drafts/${draftId}/submit`
    );
  },

  async approveConfigVersion(
    versionId: string,
    data: { reviewNote?: string; checksum?: string } = {}
  ): Promise<{ version: PlatformConfigVersionItem; approval: ConfigApprovalItem }> {
    return apiClient.post<{ version: PlatformConfigVersionItem; approval: ConfigApprovalItem }>(
      `/admin/config/versions/${versionId}/approve`,
      data
    );
  },

  async rejectConfigVersion(
    versionId: string,
    reason: string
  ): Promise<{ version: PlatformConfigVersionItem; approval: ConfigApprovalItem }> {
    return apiClient.post<{ version: PlatformConfigVersionItem; approval: ConfigApprovalItem }>(
      `/admin/config/versions/${versionId}/reject`,
      { reason }
    );
  },

  async activateConfigVersion(
    versionId: string,
    expected?: { expectedVersion?: number; expectedChecksum?: string }
  ): Promise<{ version: PlatformConfigVersionItem }> {
    return apiClient.post<{ version: PlatformConfigVersionItem }>(
      `/admin/config/versions/${versionId}/activate`,
      expected
    );
  },

  async rollbackConfigVersion(
    versionIdOrNumber: string | number,
    reason: string
  ): Promise<{ version: PlatformConfigVersionItem }> {
    return apiClient.post<{ version: PlatformConfigVersionItem }>(
      `/admin/config/versions/${versionIdOrNumber}/rollback`,
      { reason }
    );
  },

  // ==========================================================================
  // Phase 4: Feature Flags & Operational Kill Switches
  // ==========================================================================
  async getFeatureFlags(params: {
    search?: string;
    enabled?: boolean;
    isKillSwitch?: boolean;
  } = {}): Promise<{ flags: FeatureFlagItem[]; count: number }> {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (typeof params.enabled === 'boolean') q.set('enabled', params.enabled.toString());
    if (typeof params.isKillSwitch === 'boolean') q.set('isKillSwitch', params.isKillSwitch.toString());
    const qs = q.toString();
    return apiClient.get<{ flags: FeatureFlagItem[]; count: number }>(
      `/admin/feature-flags${qs ? `?${qs}` : ''}`
    );
  },

  async getFeatureFlag(key: string): Promise<{ flag: FeatureFlagItem }> {
    return apiClient.get<{ flag: FeatureFlagItem }>(`/admin/feature-flags/${encodeURIComponent(key)}`);
  },

  async getFeatureFlagHistory(
    key: string,
    params: { page?: number; limit?: number } = {}
  ): Promise<FeatureFlagHistoryResponse> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    return apiClient.get<FeatureFlagHistoryResponse>(
      `/admin/feature-flags/${encodeURIComponent(key)}/history?${q.toString()}`
    );
  },

  async evaluateFeatureFlag(
    key: string,
    data: {
      userId?: string | null;
      userTier?: PlayerTier | string | null;
      adminRoles?: AdminRole[];
      defaultValue?: boolean;
    }
  ): Promise<{ evaluation: FeatureFlagEvaluation }> {
    return apiClient.post<{ evaluation: FeatureFlagEvaluation }>(
      `/admin/feature-flags/${encodeURIComponent(key)}/evaluate`,
      data
    );
  },

  async createFeatureFlag(data: {
    key: string;
    name: string;
    description?: string | null;
    enabled?: boolean;
    rolloutPercentage?: number;
    allowedTiers?: PlayerTier[];
    allowedRoles?: AdminRole[];
    isKillSwitch?: boolean;
    metadata?: Record<string, unknown> | null;
    changeReason: string;
  }): Promise<{ flag: FeatureFlagItem }> {
    return apiClient.post<{ flag: FeatureFlagItem }>('/admin/feature-flags', data);
  },

  async updateFeatureFlag(
    key: string,
    data: {
      name?: string;
      description?: string | null;
      enabled?: boolean;
      rolloutPercentage?: number;
      allowedTiers?: PlayerTier[];
      allowedRoles?: AdminRole[];
      isKillSwitch?: boolean;
      metadata?: Record<string, unknown> | null;
      changeReason: string;
    }
  ): Promise<{ flag: FeatureFlagItem }> {
    return apiClient.patch<{ flag: FeatureFlagItem }>(
      `/admin/feature-flags/${encodeURIComponent(key)}`,
      data
    );
  },

  async toggleFeatureFlag(
    key: string,
    data: { enabled: boolean; changeReason: string }
  ): Promise<{ flag: FeatureFlagItem }> {
    return apiClient.post<{ flag: FeatureFlagItem }>(
      `/admin/feature-flags/${encodeURIComponent(key)}/toggle`,
      data
    );
  },

  async triggerFeatureFlagKillSwitch(
    key: string,
    data: { enabled: boolean; reason: string }
  ): Promise<{ flag: FeatureFlagItem }> {
    return apiClient.post<{ flag: FeatureFlagItem }>(
      `/admin/feature-flags/${encodeURIComponent(key)}/kill-switch`,
      data
    );
  },

  async deleteFeatureFlag(
    key: string,
    reason: string
  ): Promise<{ deleted: boolean; key: string; id: string }> {
    return apiClient.delete<{ deleted: boolean; key: string; id: string }>(
      `/admin/feature-flags/${encodeURIComponent(key)}?reason=${encodeURIComponent(reason)}`
    );
  },

  // ==========================================================================
  // Phase 4: Notification Templates
  // ==========================================================================
  async getNotificationChannels(): Promise<{ channels: ChannelCapabilityItem[] }> {
    return apiClient.get<{ channels: ChannelCapabilityItem[] }>('/admin/notification-templates/channels');
  },

  async getNotificationTemplates(params: {
    category?: NotificationCategory | '';
    channel?: NotificationChannel | '';
    isActive?: boolean;
    search?: string;
  } = {}): Promise<{
    templates: NotificationTemplateItem[];
    count: number;
    channelCapabilities: ChannelCapabilityItem[];
  }> {
    const q = new URLSearchParams();
    if (params.category) q.set('category', params.category);
    if (params.channel) q.set('channel', params.channel);
    if (typeof params.isActive === 'boolean') q.set('isActive', params.isActive.toString());
    if (params.search) q.set('search', params.search);
    const qs = q.toString();
    return apiClient.get(`/admin/notification-templates${qs ? `?${qs}` : ''}`);
  },

  async getNotificationTemplate(codeOrId: string): Promise<{ template: NotificationTemplateItem }> {
    return apiClient.get<{ template: NotificationTemplateItem }>(
      `/admin/notification-templates/${encodeURIComponent(codeOrId)}`
    );
  },

  async getNotificationTemplateHistory(
    codeOrId: string,
    params: { page?: number; limit?: number } = {}
  ): Promise<NotificationTemplateHistoryResponse> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    return apiClient.get<NotificationTemplateHistoryResponse>(
      `/admin/notification-templates/${encodeURIComponent(codeOrId)}/history?${q.toString()}`
    );
  },

  async previewDraftNotificationTemplate(data: {
    code?: string | null;
    title: string;
    bodyTemplate: string;
    variables?: string[];
    channels?: NotificationChannel[];
    sampleValues: Record<string, string | number | boolean>;
  }): Promise<{ preview: NotificationPreviewResult }> {
    return apiClient.post<{ preview: NotificationPreviewResult }>(
      '/admin/notification-templates/preview',
      data
    );
  },

  async previewSavedNotificationTemplate(
    codeOrId: string,
    sampleValues: Record<string, string | number | boolean>
  ): Promise<{ preview: NotificationPreviewResult }> {
    return apiClient.post<{ preview: NotificationPreviewResult }>(
      `/admin/notification-templates/${encodeURIComponent(codeOrId)}/preview`,
      { sampleValues }
    );
  },

  async createNotificationTemplate(data: {
    code: string;
    title: string;
    bodyTemplate: string;
    category: NotificationCategory;
    channels: NotificationChannel[];
    variables: string[];
    isActive?: boolean;
    changeReason: string;
  }): Promise<{ template: NotificationTemplateItem }> {
    return apiClient.post<{ template: NotificationTemplateItem }>(
      '/admin/notification-templates',
      data
    );
  },

  async updateNotificationTemplate(
    codeOrId: string,
    data: {
      title?: string;
      bodyTemplate?: string;
      category?: NotificationCategory;
      channels?: NotificationChannel[];
      variables?: string[];
      isActive?: boolean;
      changeReason: string;
    }
  ): Promise<{ template: NotificationTemplateItem }> {
    return apiClient.patch<{ template: NotificationTemplateItem }>(
      `/admin/notification-templates/${encodeURIComponent(codeOrId)}`,
      data
    );
  },

  // ==========================================================================
  // Phase 4: Maintenance Controls
  // ==========================================================================
  async getMaintenanceState(): Promise<{ maintenance: MaintenanceStateItem }> {
    return apiClient.get<{ maintenance: MaintenanceStateItem }>('/admin/maintenance');
  },

  async getMaintenanceHistory(params: {
    page?: number;
    limit?: number;
  } = {}): Promise<MaintenanceHistoryResponse> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    return apiClient.get<MaintenanceHistoryResponse>(`/admin/maintenance/history?${q.toString()}`);
  },

  async evaluateMaintenanceAccess(data: {
    path: string;
    ip?: string | null;
    adminRoles?: AdminRole[];
  }): Promise<{ decision: MaintenanceAccessDecision }> {
    return apiClient.post<{ decision: MaintenanceAccessDecision }>('/admin/maintenance/evaluate', data);
  },

  async updateMaintenanceState(data: {
    active?: boolean;
    scope?: MaintenanceScope;
    headline?: string;
    message?: string;
    allowedIps?: string[];
    allowedRoles?: AdminRole[];
    startsAt?: string | null;
    endsAt?: string | null;
    reason: string;
  }): Promise<{ maintenance: MaintenanceStateItem }> {
    return apiClient.patch<{ maintenance: MaintenanceStateItem }>('/admin/maintenance', data);
  },

  async enableMaintenance(data: {
    scope: MaintenanceScope;
    headline?: string;
    message?: string;
    allowedIps?: string[];
    allowedRoles?: AdminRole[];
    startsAt?: string | null;
    endsAt?: string | null;
    reason: string;
  }): Promise<{ maintenance: MaintenanceStateItem }> {
    return apiClient.post<{ maintenance: MaintenanceStateItem }>('/admin/maintenance/enable', data);
  },

  async disableMaintenance(reason: string): Promise<{ maintenance: MaintenanceStateItem }> {
    return apiClient.post<{ maintenance: MaintenanceStateItem }>('/admin/maintenance/disable', {
      reason
    });
  },

  async emergencyResetMaintenance(
    reason: string
  ): Promise<{ maintenance: MaintenanceStateItem; recovered: boolean }> {
    return apiClient.post<{ maintenance: MaintenanceStateItem; recovered: boolean }>(
      '/admin/maintenance/emergency-reset',
      { reason }
    );
  },

  // ==========================================================================
  // Notification History & Dev-Gated Simulation Lab
  // ==========================================================================
  async getNotifications(params: {
    page?: number;
    limit?: number;
    type?: string;
    isRead?: 'true' | 'false';
    search?: string;
  } = {}): Promise<AdminNotificationsResponse> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.type) q.set('type', params.type);
    if (params.isRead) q.set('isRead', params.isRead);
    if (params.search) q.set('search', params.search);
    return apiClient.get<AdminNotificationsResponse>(`/admin/notifications?${q.toString()}`);
  },

  async getSimulationStatus(): Promise<{ simulation: SimulationStatusSnapshot }> {
    return apiClient.get<{ simulation: SimulationStatusSnapshot }>('/admin/simulation/status');
  },

  async startSimulation(config: {
    userCount?: number;
    concurrency?: number;
    durationMs?: number;
    actionIntervalMs?: number;
    scenarios?: string[];
  }): Promise<{ simulation: SimulationStatusSnapshot }> {
    return apiClient.post<{ simulation: SimulationStatusSnapshot }>('/admin/simulation/start', config);
  },

  async pauseSimulation(): Promise<{ simulation: SimulationStatusSnapshot }> {
    return apiClient.post<{ simulation: SimulationStatusSnapshot }>('/admin/simulation/pause', {});
  },

  async resumeSimulation(): Promise<{ simulation: SimulationStatusSnapshot }> {
    return apiClient.post<{ simulation: SimulationStatusSnapshot }>('/admin/simulation/resume', {});
  },

  async stopSimulation(): Promise<{ simulation: SimulationStatusSnapshot }> {
    return apiClient.post<{ simulation: SimulationStatusSnapshot }>('/admin/simulation/stop', {});
  },

  async resetSimulation(runId?: string | null): Promise<{
    summary: { runId: string; removedUsers: number; removedMatches: number; removedTransactions: number };
    simulation: SimulationStatusSnapshot;
  }> {
    return apiClient.post('/admin/simulation/reset', runId ? { runId } : {});
  },

  async runSimulationReconciliation(): Promise<{
    reconciliationRun: { id: string; status: string; discrepancies: string[] };
  }> {
    return apiClient.post('/admin/simulation/reconcile', {});
  },

  // ==========================================================================
  // Balance Top-Ups (Deposits) & Non-Withdrawal Money Ledger
  // ==========================================================================
  async getDeposits(params: {
    page?: number;
    limit?: number;
    status?: string;
    gateway?: string;
    userId?: string;
    search?: string;
  } = {}): Promise<AdminDepositsResponse> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.status) q.set('status', params.status);
    if (params.gateway) q.set('gateway', params.gateway);
    if (params.userId) q.set('userId', params.userId);
    if (params.search) q.set('search', params.search);
    return apiClient.get<AdminDepositsResponse>(`/admin/deposits?${q.toString()}`);
  },

  async getLedgerTransactions(params: {
    page?: number;
    limit?: number;
    type?: string;
    excludeWithdrawals?: boolean;
    userId?: string;
    matchId?: string;
    search?: string;
  } = {}): Promise<AdminLedgerTransactionsResponse> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', params.page.toString());
    if (params.limit) q.set('limit', params.limit.toString());
    if (params.type) q.set('type', params.type);
    if (typeof params.excludeWithdrawals === 'boolean') {
      q.set('excludeWithdrawals', params.excludeWithdrawals ? 'true' : 'false');
    }
    if (params.userId) q.set('userId', params.userId);
    if (params.matchId) q.set('matchId', params.matchId);
    if (params.search) q.set('search', params.search);
    return apiClient.get<AdminLedgerTransactionsResponse>(`/admin/ledger/transactions?${q.toString()}`);
  }
};

