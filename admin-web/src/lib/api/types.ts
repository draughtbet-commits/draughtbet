import { AdminRole } from '../permissions/roles';
import { Permission } from '../permissions/matrix';

export interface ApiErrorResponse {
  error?: string;
  errors?: Array<{ path?: string[]; message: string }>;
  message?: string;
  statusCode?: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user?: {
    id: string;
    email: string;
    tier: string;
    isBanned: boolean;
  };
}

export interface AdminProfileResponse {
  id: string;
  email: string;
  username: string | null;
  fullName: string | null;
  roles: AdminRole[];
  permissions: Permission[];
}

export interface AuditLogItem {
  id: string;
  adminId: string;
  admin?: {
    id: string;
    email: string;
    fullName?: string | null;
  } | null;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  logs?: T[];
  withdrawals?: T[];
  cases?: T[];
  disputes?: T[];
  events?: T[];
  users?: T[];
  matches?: T[];
  restrictions?: T[];
  supportCases?: T[];
  total: number;
  page: number;
  totalPages: number;
}

export interface WithdrawalItem {
  id: string;
  userId: string;
  amountMinorUnits: string;
  currency: string;
  reference: string;
  gateway: string;
  status: 'PENDING_REVIEW' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RELEASED';
  providerRef: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  user?: {
    id: string;
    email: string;
    username?: string | null;
    fullName?: string | null;
    kycStatus?: string;
    isBanned?: boolean;
    phone?: string | null;
  };
  bankAccount?: {
    id: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
  } | null;
}

export interface VerificationCaseItem {
  id: string;
  userId: string;
  status: 'NOT_REQUIRED' | 'REQUIRED' | 'STARTED' | 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  provider: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    email: string;
    username?: string | null;
    fullName?: string | null;
    phone?: string | null;
    dateOfBirth?: string | null;
    countryCode?: string | null;
    isBanned?: boolean;
    ageVerified: boolean;
    tier?: string;
    kycStatus?: string;
  };
  checks?: Array<{
    id: string;
    caseId?: string;
    type: string;
    status: string;
    verifiedAt: string | null;
    createdAt?: string;
    providerCheckId?: string | null;
    providerResponse?: Record<string, unknown> | null;
  }>;
  statusHistory?: Array<{
    id: string;
    status: string;
    provider: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  }>;
  auditHistory?: AuditLogItem[];
}

export interface VerificationDocumentAccessResponse {
  caseId: string;
  checkId: string | null;
  checkType: string;
  checkStatus: string;
  provider: string;
  signedToken: string;
  expiresAt: string;
  expiresInSeconds: number;
  watermark: string;
  sanitizedVerdict?: Record<string, unknown>;
  access?: {
    caseId: string;
    checkId: string | null;
    checkType: string;
    checkStatus: string;
    provider: string;
    signedToken: string;
    expiresAt: string;
    expiresInSeconds: number;
    watermark: string;
    sanitizedVerdict?: Record<string, unknown>;
  };
}

export interface DisputeItem {
  id: string;
  matchId: string;
  raisedBy: string;
  userId?: string;
  user?: {
    id: string;
    email: string;
    username?: string | null;
    fullName?: string | null;
  } | null;
  raisedByEmail?: string | null;
  raisedByUser?: {
    id: string;
    email: string;
    username?: string | null;
    fullName?: string | null;
  } | null;
  decidedByUser?: {
    id: string;
    email: string;
    username?: string | null;
    fullName?: string | null;
  } | null;
  status: 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED';
  reason: string;
  description?: string | null;
  resolution: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  evidence?: Array<{
    id: string;
    type: string;
    url: string;
    description: string | null;
    uploadedAt?: string;
    createdAt?: string;
  }>;
  match?: {
    id: string;
    status: string;
    tier?: string;
    stakeMinorUnits?: string;
    winnerId?: string | null;
    endReason?: string | null;
    playerLightId?: string;
    playerDarkId?: string;
    playerLight?: { id: string; email?: string; username?: string | null } | null;
    playerDark?: { id: string; email?: string; username?: string | null } | null;
  };
  auditHistory?: AuditLogItem[];
  moves?: Array<{
    id: string;
    moveNumber: number;
    playerId: string;
    fromSquare: number;
    toSquare: number;
    isKingMove: boolean;
    createdAt: string;
  }>;
  connectionEvents?: Array<{
    id: string;
    userId: string;
    state: string;
    createdAt: string;
  }>;
}

export interface RiskEventItem {
  id: string;
  userId: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  metadata: Record<string, unknown> | null;
  createdAt: string;
  user?: {
    id: string;
    email: string;
    username?: string | null;
  };
}

export interface RiskCaseNote {
  id?: string;
  authorId?: string | null;
  actionType?: string;
  note: string;
  createdAt?: string;
}

export interface RiskCaseItem {
  id: string;
  subjectId: string;
  status: 'OPEN' | 'INVESTIGATING' | 'ESCALATED' | 'RESOLVED' | 'DISMISSED';
  assignedTo: string | null;
  notes: RiskCaseNote[] | Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  subject?: {
    id: string;
    email: string;
    username: string | null;
    fullName: string | null;
    phone?: string | null;
    tier?: string;
    kycStatus: string;
    ageVerified?: boolean;
    countryCode?: string | null;
    isBanned: boolean;
    createdAt?: string;
  } | null;
  events?: RiskEventItem[];
  saferPlayProfile?: {
    timeoutUntil: string | null;
    selfExcludedUntil: string | null;
    depositLimitMinorUnits: string | null;
    stakeLimitMinorUnits: string | null;
  } | null;
  saferPlayEvents?: Array<{
    id: string;
    action: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
    createdAt: string;
  }>;
  auditHistory?: AuditLogItem[];
}

export interface SaferPlayRestrictionItem {
  id: string;
  userId: string;
  timeoutUntil: string | null;
  selfExcludedUntil: string | null;
  depositLimitMinorUnits: string | null;
  pendingDepositLimitMinorUnits?: string | null;
  stakeLimitMinorUnits: string | null;
  pendingStakeLimitMinorUnits?: string | null;
  updatedAt: string;
  createdAt: string;
  user?: {
    id: string;
    email: string;
    username: string | null;
    fullName: string | null;
    kycStatus: string;
    isBanned: boolean;
  };
}

export interface MatchListItem {
  id: string;
  tier: string;
  status: string;
  stakeMinorUnits: string;
  currency: string;
  winnerId: string | null;
  endReason: string | null;
  settlementCommissionPercent: number | null;
  timeControlSeconds: number | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  playerLight: {
    id: string;
    email?: string;
    username?: string | null;
    fullName?: string | null;
  };
  playerDark: {
    id: string;
    email?: string;
    username?: string | null;
    fullName?: string | null;
  };
  disputesCount?: number;
}

export interface MatchDetailResponse {
  match: {
    id: string;
    tier: string;
    status: string;
    stakeMinorUnits: string;
    currency: string;
    winnerId: string | null;
    endReason: string | null;
    settlementCommissionPercent: number | null;
    timeControlSeconds: number | null;
    rulesetVersion: number | null;
    configurationVersion: number | null;
    createdAt: string;
    confirmedAt: string | null;
    startedAt: string | null;
    endedAt: string | null;
    cancelledAt: string | null;
    playerLight: {
      id: string;
      email?: string;
      username?: string | null;
      fullName?: string | null;
      tier?: string;
      kycStatus?: string;
      isBanned?: boolean;
    };
    playerDark: {
      id: string;
      email?: string;
      username?: string | null;
      fullName?: string | null;
      tier?: string;
      kycStatus?: string;
      isBanned?: boolean;
    };
    participants: Array<{
      id: string;
      userId: string;
      side: 'LIGHT' | 'DARK';
      joinedAt: string;
    }>;
    stakeReservations: Array<{
      id: string;
      userId: string;
      amountMinorUnits: string;
      status: string;
      createdAt: string;
    }>;
    settlements: Array<{
      id: string;
      winnerId: string | null;
      endReason: string;
      feeSnapshotBps: number;
      netPayoutMinorUnits: string;
      status: string;
      settledAt: string | null;
    }>;
    receipts: Array<{
      id: string;
      userId: string;
      stakeMinorUnits: string;
      payoutMinorUnits: string;
      feeMinorUnits: string;
      createdAt: string;
    }>;
    disputeCases: DisputeItem[];
    gameState: {
      boardState: unknown;
      currentTurn: string;
      stateVersion: number;
      whiteRemainingMs?: string | null;
      blackRemainingMs?: string | null;
    } | null;
    moves: Array<{
      id: string;
      moveNumber: number;
      playerId: string;
      fromSquare: number;
      toSquare: number;
      capturedSquares: number[];
      isKingMove: boolean;
      boardStateAfter: unknown;
      createdAt: string;
    }>;
    connectionEvents: Array<{
      id: string;
      userId: string;
      state: string;
      ipAddress: string | null;
      userAgent: string | null;
      createdAt: string;
    }>;
    gameEvents: Array<{
      id: string;
      playerId: string | null;
      type: string;
      payload: unknown;
      createdAt: string;
    }>;
    ledgerTransactions: Array<{
      id: string;
      type: string;
      description: string | null;
      createdAt: string;
      entries: Array<{
        id: string;
        accountId: string;
        amountMinorUnits: string;
      }>;
    }>;
  };
}

export interface SupportCaseItem {
  id: string;
  reference: string;
  userId: string;
  subject: string;
  description: string;
  category: 'ACCOUNT' | 'MATCH_DISPUTE' | 'DEPOSIT' | 'WITHDRAWAL' | 'KYC_COMPLIANCE' | 'TECHNICAL' | 'OTHER';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_PLAYER' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';
  assignedTo: string | null;
  relatedMatchId: string | null;
  relatedTransactionRef: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    email: string;
    username: string | null;
    fullName: string | null;
    phone?: string | null;
    kycStatus?: string;
    isBanned?: boolean;
    createdAt?: string;
  };
  notes?: Array<{
    id: string;
    authorId: string;
    authorEmail?: string | null;
    eventType: string;
    body: string;
    metadata?: unknown;
    createdAt: string;
  }>;
  relatedMatch?: {
    id: string;
    status: string;
    tier: string;
    stakeMinorUnits: string;
    winnerId: string | null;
    endReason: string | null;
    createdAt: string;
  } | null;
  relatedWithdrawal?: {
    id: string;
    reference: string;
    amountMinorUnits: string;
    status: string;
    gateway: string;
    createdAt: string;
  } | null;
  auditHistory?: AuditLogItem[];
}

export interface SystemHealthResponse {
  health: {
    status: 'HEALTHY' | 'DEGRADED';
    timestamp: string;
    services: {
      database: {
        status: string;
        provider: string;
        latencyMs: number;
      };
      cacheAndQueues: {
        status: string;
        provider: string;
        latencyMs: number;
      };
      outboxDrainer: {
        status: string;
        pendingCount: number;
        failedCount: number;
      };
      gameSocketLayer: {
        status: string;
        activeMatchesCount: number;
      };
      paymentGateways: {
        paystack: { status: string; mode: string };
        flutterwave: { status: string; mode: string };
      };
    };
    metrics: {
      auditActionsLastHour: number;
      activeMatches: number;
    };
  };
}

export interface DashboardSummaryResponse {
  players: {
    total: number;
    active: number;
    banned: number;
  };
  matches: {
    total: number;
    active: number;
    completed: number;
    disputed: number;
  };
  compliance: {
    pendingKyc: number;
    openRiskCases: number;
  };
  financials: {
    pendingWithdrawalsCount: number;
    pendingWithdrawalsAmountMinorUnits: string;
    completedWithdrawals24hCount: number;
    completedWithdrawals24hAmountMinorUnits: string;
    reportingPeriod: string;
    currency: string;
  } | null;
  recentActivity: AuditLogItem[];
  generatedAt: string;
}

export interface PlayerListItem {
  id: string;
  email: string;
  username: string | null;
  fullName: string | null;
  phone: string | null;
  tier: string;
  kycStatus: string;
  ageVerified: boolean;
  countryCode: string | null;
  isBanned: boolean;
  isAdmin: boolean;
  createdAt: string;
}

export interface PlayerMatchItem {
  id: string;
  tier: string;
  stakeMinorUnits: string;
  status: string;
  winnerId: string | null;
  endReason: string | null;
  createdAt: string;
  endedAt: string | null;
  playerLightId: string;
  playerDarkId: string;
}

export interface PlayerSessionItem {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
  deviceInfo: Record<string, unknown> | null;
}

export interface PlayerDeviceItem {
  id: string;
  fingerprintHash: string;
  firstSeen: string;
  lastSeen: string;
}

export interface PlayerFinancials {
  projections: {
    available: string;
    locked: string;
    pending: string;
  };
  withdrawals: Array<{
    id: string;
    amountMinorUnits: string;
    currency: string;
    reference: string;
    status: string;
    gateway: string;
    reviewedBy: string | null;
    reviewedAt: string | null;
    failureReason: string | null;
    bankAccount: {
      bankName: string;
      accountNumber: string;
      accountName?: string;
    } | null;
    createdAt: string;
  }>;
  recentEntries: Array<{
    id: string;
    accountId: string;
    amountMinorUnits: string;
    direction: 'CREDIT' | 'DEBIT';
    reference: string;
    description: string | null;
    createdAt: string;
  }>;
}

export interface PlayerDetailResponse {
  user: {
    id: string;
    email: string;
    phone: string | null;
    username: string | null;
    fullName: string | null;
    address: string | null;
    avatar: string | null;
    tier: string;
    ageVerified: boolean;
    kycStatus: string;
    countryCode: string | null;
    dateOfBirth: string | null;
    isBanned: boolean;
    isAdmin: boolean;
    createdAt: string;
    saferPlayProfile: {
      timeoutUntil: string | null;
      selfExclusionUntil: string | null;
      dailyDepositLimitMinorUnits: string | null;
      lossLimitMinorUnits: string | null;
      sessionTimeLimitMinutes: number | null;
    } | null;
    saferPlayEvents: Array<{
      id: string;
      action: string;
      field: string;
      oldValue: unknown;
      newValue: unknown;
      createdAt: string;
    }>;
    verificationCases: VerificationCaseItem[];
    sessions: PlayerSessionItem[];
    devices: PlayerDeviceItem[];
    matches: PlayerMatchItem[];
    adminHistory: AuditLogItem[];
    financials: PlayerFinancials | null;
  };
}

