import prisma from '../../utils/db.js';
import {
  postAdjustment,
  getLedgerAvailable,
  getUserLedgerProjections
} from '../../services/ledgerService.js';
import { enqueueWalletUpdated } from '../../services/outboxService.js';
import { PERMISSIONS, roleHasPermission } from '../rbac/permissions.js';
import { serializeBankAccountForAdmin } from '../../utils/bankMask.js';

export class UserNotFoundError extends Error {
  constructor(message = 'User not found') {
    super(message);
    this.name = 'UserNotFoundError';
    this.statusCode = 404;
  }
}

export class ResourceNotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'ResourceNotFoundError';
    this.statusCode = 404;
  }
}

const serializeSaferPlayProfile = (profile) => {
  if (!profile) return null;
  const depositLimit = profile.depositLimitMinorUnits?.toString() ?? null;
  const stakeLimit = profile.stakeLimitMinorUnits?.toString() ?? null;
  const selfExcluded = profile.selfExcludedUntil ?? profile.selfExclusionUntil ?? null;
  return {
    id: profile.id,
    userId: profile.userId,
    timeoutUntil: profile.timeoutUntil ?? null,
    selfExcludedUntil: selfExcluded,
    selfExclusionUntil: selfExcluded,
    depositLimitMinorUnits: depositLimit,
    dailyDepositLimitMinorUnits: depositLimit,
    stakeLimitMinorUnits: stakeLimit,
    lossLimitMinorUnits: stakeLimit,
    pendingDepositLimitMinorUnits: profile.pendingDepositLimitMinorUnits?.toString() ?? null,
    pendingDepositLimitRaisedAt: profile.pendingDepositLimitRaisedAt ?? null,
    pendingStakeLimitMinorUnits: profile.pendingStakeLimitMinorUnits?.toString() ?? null,
    pendingStakeLimitRaisedAt: profile.pendingStakeLimitRaisedAt ?? null,
    sessionTimeLimitMinutes: null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
};

const normalizeRiskNotes = (notes) => {
  if (!notes) return [];
  if (Array.isArray(notes)) return notes;
  if (Array.isArray(notes.entries)) return notes.entries;
  if (typeof notes === 'object') {
    return [
      {
        id: 'legacy-note',
        authorId: notes.authorId ?? null,
        actionType: notes.actionType ?? 'NOTE',
        note: notes.text || notes.note || JSON.stringify(notes),
        createdAt: notes.createdAt ?? new Date().toISOString()
      }
    ];
  }
  return [];
};

/**
 * Admin operations service: dashboard aggregations, player directory / details,
 * and sanctioned double-entry ledger money corrections.
 */
export class AdminService {
  /**
   * Operations Dashboard Aggregations.
   * Tailored by role: operational counts are exposed to all 6 admin roles,
   * while financial totals are restricted to roles with withdrawal or ledger permissions.
   */
  static async getDashboardSummary({ adminRoles = [], dbp = prisma } = {}) {
    const canAccessFinancials = adminRoles.some(
      (role) =>
        roleHasPermission(role, PERMISSIONS.WITHDRAWALS_READ) ||
        roleHasPermission(role, PERMISSIONS.LEDGER_ADJUST)
    );

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const baseQueries = [
      dbp.user.count(),
      dbp.user.count({ where: { isBanned: false } }),
      dbp.user.count({ where: { isBanned: true } }),
      dbp.match.count(),
      dbp.match.count({ where: { status: { in: ['ACTIVE', 'FUNDED', 'READY', 'IN_PLAY'] } } }),
      dbp.match.count({ where: { status: { in: ['COMPLETED', 'SETTLED'] } } }),
      dbp.disputeCase.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      dbp.verificationCase.count({
        where: { status: { in: ['PENDING', 'UNDER_REVIEW', 'REQUIRED', 'STARTED'] } }
      }),
      dbp.riskCase.count({ where: { status: { in: ['OPEN', 'INVESTIGATING'] } } }),
      dbp.adminAuditLog.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          adminId: true,
          action: true,
          outcome: true,
          targetType: true,
          targetId: true,
          metadata: true,
          createdAt: true
        }
      })
    ];

    const financialQueries = canAccessFinancials
      ? [
        dbp.withdrawal.count({ where: { status: 'PENDING_REVIEW' } }),
        dbp.withdrawal.aggregate({
          where: { status: 'PENDING_REVIEW' },
          _sum: { amountMinorUnits: true }
        }),
        dbp.withdrawal.count({
          where: { status: 'COMPLETED', updatedAt: { gte: last24h } }
        }),
        dbp.withdrawal.aggregate({
          where: { status: 'COMPLETED', updatedAt: { gte: last24h } },
          _sum: { amountMinorUnits: true }
        })
      ]
      : [];

    const results = await Promise.all([...baseQueries, ...financialQueries]);

    const [
      totalUsers,
      activeUsers,
      bannedUsers,
      totalMatches,
      activeMatches,
      completedMatches,
      openDisputes,
      pendingKyc,
      openRiskCases,
      recentAudits
    ] = results.slice(0, 10);

    let financialSummary = null;
    if (canAccessFinancials) {
      const [
        pendingWithdrawalsCount,
        pendingWithdrawalsSum,
        completedWithdrawals24hCount,
        completedWithdrawals24hSum
      ] = results.slice(10);

      financialSummary = {
        pendingWithdrawalsCount,
        pendingWithdrawalsAmountMinorUnits: (
          pendingWithdrawalsSum?._sum?.amountMinorUnits ?? 0n
        ).toString(),
        completedWithdrawals24hCount,
        completedWithdrawals24hAmountMinorUnits: (
          completedWithdrawals24hSum?._sum?.amountMinorUnits ?? 0n
        ).toString(),
        reportingPeriod: '24h',
        currency: 'NGN'
      };
    }

    return {
      players: {
        total: totalUsers,
        active: activeUsers,
        banned: bannedUsers
      },
      matches: {
        total: totalMatches,
        active: activeMatches,
        completed: completedMatches,
        disputed: openDisputes
      },
      compliance: {
        pendingKyc,
        openRiskCases
      },
      financials: financialSummary,
      recentActivity: recentAudits,
      generatedAt: now.toISOString()
    };
  }

  /**
   * Filtered, paginated player directory.
   */
  static async listUsers({
    page = 1,
    limit = 20,
    search,
    isBanned,
    kycStatus,
    dateFrom,
    dateTo,
    sortBy = 'createdAt',
    order = 'desc',
    dbp = prisma
  } = {}) {
    const skip = (page - 1) * limit;
    const where = {};

    if (search && typeof search === 'string' && search.trim() !== '') {
      const term = search.trim();
      where.OR = [
        { id: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { username: { contains: term, mode: 'insensitive' } },
        { fullName: { contains: term, mode: 'insensitive' } },
        { displayName: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } }
      ];
    }

    if (typeof isBanned === 'boolean') {
      where.isBanned = isBanned;
    }

    if (kycStatus && ['NONE', 'PENDING', 'VERIFIED'].includes(kycStatus)) {
      where.kycStatus = kycStatus;
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        const fromDate = new Date(dateFrom);
        if (!isNaN(fromDate.getTime())) where.createdAt.gte = fromDate;
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        if (!isNaN(toDate.getTime())) where.createdAt.lte = toDate;
      }
    }

    const validSortFields = ['createdAt', 'email', 'username', 'kycStatus'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const [users, total] = await Promise.all([
      dbp.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          phone: true,
          tier: true,
          kycStatus: true,
          ageVerified: true,
          countryCode: true,
          isBanned: true,
          isAdmin: true,
          createdAt: true
        },
        orderBy: { [sortField]: sortOrder },
        skip,
        take: limit
      }),
      dbp.user.count({ where })
    ]);

    return {
      users,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }

  /**
   * Detailed player profile.
   * Exposes basic identity, KYC cases, gameplay history, safer play, and session context.
   * Financial projections and ledger history are included only if the operator is authorized.
   */
  static async getUserDetail({ userId, adminRoles = [], dbp = prisma }) {
    const user = await dbp.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        username: true,
        fullName: true,
        address: true,
        avatar: true,
        tier: true,
        ageVerified: true,
        kycStatus: true,
        countryCode: true,
        dateOfBirth: true,
        isBanned: true,
        isAdmin: true,
        createdAt: true,
        saferPlayProfile: true,
        saferPlayEvents: {
          take: 10,
          orderBy: { createdAt: 'desc' }
        },
        verificationCases: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { checks: true }
        },
        sessions: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            ipAddress: true,
            userAgent: true,
            status: true,
            expiresAt: true,
            createdAt: true,
            deviceInfo: true
          }
        },
        devices: {
          take: 5,
          orderBy: { lastSeen: 'desc' }
        }
      }
    });

    if (!user) {
      throw new UserNotFoundError();
    }

    const recentMatches = await dbp.match.findMany({
      where: {
        OR: [{ playerLightId: userId }, { playerDarkId: userId }]
      },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tier: true,
        stakeMinorUnits: true,
        status: true,
        winnerId: true,
        endReason: true,
        createdAt: true,
        endedAt: true,
        playerLightId: true,
        playerDarkId: true
      }
    });

    const auditLogs = await dbp.adminAuditLog.findMany({
      where: {
        OR: [
          { targetType: 'user', targetId: userId },
          { targetId: userId }
        ]
      },
      take: 10,
      orderBy: { createdAt: 'desc' }
    });

    const canAccessFinancials = adminRoles.some(
      (role) =>
        roleHasPermission(role, PERMISSIONS.WITHDRAWALS_READ) ||
        roleHasPermission(role, PERMISSIONS.LEDGER_ADJUST)
    );

    let financials = null;
    if (canAccessFinancials) {
      const [projections, withdrawals, ledgerAccounts] = await Promise.all([
        getUserLedgerProjections(dbp, userId, 'NGN').catch(() => ({
          available: '0',
          locked: '0',
          pending: '0'
        })),
        dbp.withdrawal.findMany({
          where: { userId },
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { bankAccount: true }
        }),
        dbp.ledgerAccount.findMany({
          where: { userId }
        })
      ]);

      const accountIds = ledgerAccounts.map((a) => a.id);
      const recentLedgerEntries =
        accountIds.length > 0
          ? await dbp.ledgerEntry.findMany({
            where: { accountId: { in: accountIds } },
            take: 20,
            orderBy: { createdAt: 'desc' },
            include: { transaction: true }
          })
          : [];

      financials = {
        projections,
        withdrawals: withdrawals.map((w) => ({
          id: w.id,
          amountMinorUnits: w.amountMinorUnits.toString(),
          currency: w.currency,
          reference: w.reference,
          status: w.status,
          gateway: w.gateway,
          reviewedBy: w.reviewedBy,
          reviewedAt: w.reviewedAt,
          failureReason: w.failureReason,
          bankAccount: serializeBankAccountForAdmin(w.bankAccount),
          createdAt: w.createdAt
        })),
        recentEntries: recentLedgerEntries.map((e) => ({
          id: e.id,
          accountId: e.accountId,
          amountMinorUnits: (e.amountMinorUnits < 0n ? -e.amountMinorUnits : e.amountMinorUnits).toString(),
          direction: e.amountMinorUnits >= 0n ? 'CREDIT' : 'DEBIT',
          reference: e.transaction.reference,
          description: e.transaction.description,
          createdAt: e.createdAt
        }))
      };
    }

    return {
      user: {
        ...user,
        saferPlayProfile: serializeSaferPlayProfile(user.saferPlayProfile),
        matches: recentMatches.map((m) => ({
          ...m,
          stakeMinorUnits: m.stakeMinorUnits.toString()
        })),
        adminHistory: auditLogs,
        financials
      }
    };
  }

  // =========================================================================
  // MODULE B: Risk & Investigation Case Management
  // =========================================================================

  static async listRiskCases({ page = 1, limit = 20, status, search, dbp = prisma } = {}) {
    const where = {};
    if (status && ['OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED', 'DISMISSED'].includes(status)) {
      where.status = status;
    }
    if (search && typeof search === 'string' && search.trim() !== '') {
      const term = search.trim();
      where.OR = [
        { id: { contains: term, mode: 'insensitive' } },
        { subjectId: { contains: term, mode: 'insensitive' } },
        { assignedTo: { contains: term, mode: 'insensitive' } }
      ];
    }
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      dbp.riskCase.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit
      }),
      dbp.riskCase.count({ where })
    ]);

    const subjectIds = [...new Set(rows.map((r) => r.subjectId).filter(Boolean))];
    const subjects = subjectIds.length > 0
      ? await dbp.user.findMany({
        where: { id: { in: subjectIds } },
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          kycStatus: true,
          isBanned: true
        }
      })
      : [];
    const subjectMap = new Map(subjects.map((s) => [s.id, s]));

    const cases = rows.map((r) => ({
      ...r,
      notes: normalizeRiskNotes(r.notes),
      subject: subjectMap.get(r.subjectId) ?? null
    }));

    return {
      cases,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  static async getRiskCaseDetail({ caseId, dbp = prisma } = {}) {
    const row = await dbp.riskCase.findUnique({ where: { id: caseId } });
    if (!row) throw new ResourceNotFoundError('Risk case not found');

    const [subject, events, saferProfile, saferEvents, auditHistory] = await Promise.all([
      dbp.user.findUnique({
        where: { id: row.subjectId },
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          phone: true,
          tier: true,
          kycStatus: true,
          ageVerified: true,
          countryCode: true,
          isBanned: true,
          createdAt: true
        }
      }),
      dbp.riskEvent.findMany({
        where: { userId: row.subjectId },
        orderBy: { createdAt: 'desc' },
        take: 30
      }),
      dbp.saferPlayProfile.findUnique({ where: { userId: row.subjectId } }),
      dbp.saferPlayEvent.findMany({
        where: { userId: row.subjectId },
        orderBy: { createdAt: 'desc' },
        take: 20
      }),
      dbp.adminAuditLog.findMany({
        where: {
          OR: [
            { targetType: 'risk-case', targetId: caseId },
            { targetType: 'user', targetId: row.subjectId },
            { targetId: caseId }
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: 30
      })
    ]);

    return {
      riskCase: {
        ...row,
        notes: normalizeRiskNotes(row.notes),
        subject,
        events,
        saferPlayProfile: serializeSaferPlayProfile(saferProfile),
        saferPlayEvents: saferEvents,
        auditHistory
      }
    };
  }

  static async addRiskCaseNote({ caseId, note, actionType = 'NOTE', authorId = null, dbp = prisma } = {}) {
    const existing = await dbp.riskCase.findUnique({ where: { id: caseId } });
    if (!existing) throw new ResourceNotFoundError('Risk case not found');

    const currentNotes = normalizeRiskNotes(existing.notes);
    const newEntry = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      authorId,
      actionType,
      note: note.trim(),
      createdAt: new Date().toISOString()
    };

    const updated = await dbp.riskCase.update({
      where: { id: caseId },
      data: {
        notes: [...currentNotes, newEntry],
        updatedAt: new Date()
      }
    });

    return {
      riskCase: {
        ...updated,
        notes: normalizeRiskNotes(updated.notes)
      },
      note: newEntry
    };
  }

  // =========================================================================
  // MODULE C: Matches & Canonical Evidence Operations
  // =========================================================================

  static async listMatches({ page = 1, limit = 20, status, search, dbp = prisma } = {}) {
    const VALID_MATCH_STATUSES = new Set([
      'PENDING', 'ACTIVE', 'COMPLETED', 'FORFEITED', 'DISPUTED', 'RELEASED',
      'DRAFT', 'OPEN', 'FUNDED', 'READY', 'IN_PLAY', 'SETTLED', 'CANCELLED', 'EXPIRED'
    ]);
    const STATUS_ALIASES = {
      IN_PROGRESS: { in: ['ACTIVE', 'FUNDED', 'READY', 'IN_PLAY'] },
      COMPLETED: { in: ['COMPLETED', 'SETTLED'] },
      ABANDONED: { in: ['FORFEITED', 'EXPIRED'] }
    };

    const where = {};
    if (status && typeof status === 'string' && status.trim() !== '') {
      const normalized = status.trim().toUpperCase();
      if (STATUS_ALIASES[normalized]) {
        where.status = STATUS_ALIASES[normalized];
      } else if (VALID_MATCH_STATUSES.has(normalized)) {
        where.status = normalized;
      } else {
        return { matches: [], total: 0, page, totalPages: 1 };
      }
    }
    if (search && typeof search === 'string' && search.trim() !== '') {
      const term = search.trim();
      where.OR = [
        { id: { contains: term, mode: 'insensitive' } },
        { playerLightId: { contains: term, mode: 'insensitive' } },
        { playerDarkId: { contains: term, mode: 'insensitive' } }
      ];
    }
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      dbp.match.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          disputeCases: { select: { id: true, status: true, reason: true } }
        }
      }),
      dbp.match.count({ where })
    ]);

    const playerIds = [
      ...new Set(rows.flatMap((m) => [m.playerLightId, m.playerDarkId]).filter(Boolean))
    ];
    const players = playerIds.length > 0
      ? await dbp.user.findMany({
        where: { id: { in: playerIds } },
        select: { id: true, email: true, username: true, fullName: true, tier: true, kycStatus: true }
      })
      : [];
    const playerMap = new Map(players.map((p) => [p.id, p]));

    const matches = rows.map((m) => ({
      id: m.id,
      tier: m.tier,
      status: m.status,
      stakeMinorUnits: m.stakeMinorUnits.toString(),
      currency: m.currency || 'NGN',
      winnerId: m.winnerId,
      endReason: m.endReason,
      settlementCommissionPercent: m.settlementCommissionPercent,
      timeControlSeconds: m.timeControlSeconds,
      createdAt: m.createdAt,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      playerLight: playerMap.get(m.playerLightId) ?? { id: m.playerLightId },
      playerDark: playerMap.get(m.playerDarkId) ?? { id: m.playerDarkId },
      disputesCount: m.disputeCases?.length ?? 0,
      disputeCases: m.disputeCases ?? []
    }));

    return {
      matches,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  static async getMatchDetail({ matchId, dbp = prisma } = {}) {
    const match = await dbp.match.findUnique({
      where: { id: matchId },
      include: {
        participants: true,
        stakeReservations: true,
        settlements: true,
        receipts: true,
        disputeCases: {
          include: { evidence: true }
        },
        gameState: true,
        outbox: true
      }
    });
    if (!match) throw new ResourceNotFoundError('Match not found');

    const playerIds = [match.playerLightId, match.playerDarkId].filter(Boolean);
    const [players, moves, connectionEvents, gameEvents, ledgerTransactions] = await Promise.all([
      dbp.user.findMany({
        where: { id: { in: playerIds } },
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          tier: true,
          kycStatus: true,
          isBanned: true
        }
      }),
      dbp.matchMove.findMany({
        where: { matchId },
        orderBy: { moveNumber: 'asc' },
        take: 200
      }),
      dbp.matchConnectionEvent.findMany({
        where: { matchId },
        orderBy: { createdAt: 'desc' },
        take: 50
      }),
      dbp.gameEvent.findMany({
        where: { matchId },
        orderBy: { createdAt: 'asc' },
        take: 100
      }),
      dbp.ledgerTransaction.findMany({
        where: { relatedMatchId: matchId },
        include: { entries: true },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const playerMap = new Map(players.map((p) => [p.id, p]));

    return {
      match: {
        id: match.id,
        tier: match.tier,
        status: match.status,
        stakeMinorUnits: match.stakeMinorUnits.toString(),
        currency: match.currency || 'NGN',
        winnerId: match.winnerId,
        endReason: match.endReason,
        settlementCommissionPercent: match.settlementCommissionPercent,
        timeControlSeconds: match.timeControlSeconds,
        rulesetVersion: match.rulesetVersion,
        configurationVersion: match.configurationVersion,
        createdAt: match.createdAt,
        confirmedAt: match.confirmedAt,
        startedAt: match.startedAt,
        endedAt: match.endedAt,
        cancelledAt: match.cancelledAt,
        playerLight: playerMap.get(match.playerLightId) ?? { id: match.playerLightId },
        playerDark: playerMap.get(match.playerDarkId) ?? { id: match.playerDarkId },
        participants: match.participants,
        stakeReservations: match.stakeReservations.map((r) => ({
          ...r,
          amountMinorUnits: r.amountMinorUnits.toString()
        })),
        settlements: match.settlements.map((s) => ({
          ...s,
          netPayoutMinorUnits: s.netPayoutMinorUnits.toString()
        })),
        receipts: match.receipts.map((rc) => ({
          ...rc,
          stakeMinorUnits: rc.stakeMinorUnits.toString(),
          payoutMinorUnits: rc.payoutMinorUnits.toString(),
          feeMinorUnits: rc.feeMinorUnits.toString()
        })),
        disputeCases: match.disputeCases,
        gameState: match.gameState,
        outbox: match.outbox ? {
          ...match.outbox,
          stakeMinorUnits: match.outbox.stakeMinorUnits.toString()
        } : null,
        moves,
        connectionEvents,
        gameEvents,
        ledgerTransactions: ledgerTransactions.map((tx) => ({
          ...tx,
          entries: tx.entries.map((e) => ({
            ...e,
            amountMinorUnits: e.amountMinorUnits.toString()
          }))
        }))
      }
    };
  }

  static async getDisputeDetail({ disputeId, dbp = prisma } = {}) {
    const dispute = await dbp.disputeCase.findUnique({
      where: { id: disputeId },
      include: {
        evidence: { orderBy: { uploadedAt: 'asc' } },
        match: {
          select: {
            id: true,
            tier: true,
            status: true,
            stakeMinorUnits: true,
            winnerId: true,
            endReason: true,
            playerLightId: true,
            playerDarkId: true,
            createdAt: true,
            endedAt: true
          }
        }
      }
    });
    if (!dispute) throw new ResourceNotFoundError('Dispute case not found');

    const userIds = [
      dispute.raisedBy,
      dispute.decidedBy,
      dispute.match?.playerLightId,
      dispute.match?.playerDarkId
    ].filter(Boolean);

    const users = userIds.length > 0
      ? await dbp.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, username: true, fullName: true }
      })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const [auditHistory, moves, connectionEvents] = await Promise.all([
      dbp.adminAuditLog.findMany({
        where: {
          OR: [
            { targetType: 'dispute', targetId: disputeId },
            { targetId: disputeId }
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: 30
      }),
      dispute.matchId
        ? dbp.matchMove.findMany({
          where: { matchId: dispute.matchId },
          orderBy: { moveNumber: 'asc' },
          take: 100
        })
        : Promise.resolve([]),
      dispute.matchId
        ? dbp.matchConnectionEvent.findMany({
          where: { matchId: dispute.matchId },
          orderBy: { createdAt: 'desc' },
          take: 30
        })
        : Promise.resolve([])
    ]);

    return {
      dispute: {
        ...dispute,
        raisedByUser: userMap.get(dispute.raisedBy) ?? null,
        decidedByUser: dispute.decidedBy ? userMap.get(dispute.decidedBy) ?? null : null,
        match: dispute.match ? {
          ...dispute.match,
          stakeMinorUnits: dispute.match.stakeMinorUnits.toString(),
          playerLight: userMap.get(dispute.match.playerLightId) ?? null,
          playerDark: userMap.get(dispute.match.playerDarkId) ?? null
        } : null,
        auditHistory,
        moves,
        connectionEvents
      }
    };
  }

  // =========================================================================
  // MODULE D: Customer Support Operations
  // =========================================================================

  static async listSupportCases({
    page = 1,
    limit = 20,
    status,
    priority,
    category,
    search,
    dbp = prisma
  } = {}) {
    const where = {};
    if (status && ['OPEN', 'IN_PROGRESS', 'WAITING_ON_PLAYER', 'ESCALATED', 'RESOLVED', 'CLOSED'].includes(status)) {
      where.status = status;
    }
    if (priority && ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(priority)) {
      where.priority = priority;
    }
    if (category && ['ACCOUNT', 'MATCH_DISPUTE', 'DEPOSIT', 'WITHDRAWAL', 'KYC_COMPLIANCE', 'TECHNICAL', 'OTHER'].includes(category)) {
      where.category = category;
    }

    if (search && typeof search === 'string' && search.trim() !== '') {
      const term = search.trim();
      where.OR = [
        { reference: { contains: term, mode: 'insensitive' } },
        { subject: { contains: term, mode: 'insensitive' } },
        { relatedTransactionRef: { contains: term, mode: 'insensitive' } },
        { relatedMatchId: { contains: term, mode: 'insensitive' } },
        { user: { email: { contains: term, mode: 'insensitive' } } },
        { user: { username: { contains: term, mode: 'insensitive' } } }
      ];
    }

    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      dbp.supportCase.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        skip,
        take: limit,
        include: {
          user: {
            select: { id: true, email: true, username: true, fullName: true, kycStatus: true, isBanned: true }
          },
          notes: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          }
        }
      }),
      dbp.supportCase.count({ where })
    ]);

    return {
      cases: (rows || []).map((r) => ({
        ...r,
        user: r.user ?? null,
        notes: Array.isArray(r.notes) ? r.notes : []
      })),
      total: total ?? 0,
      page,
      totalPages: Math.max(1, Math.ceil((total ?? 0) / limit))
    };
  }

  static async getSupportCaseDetail({ caseId, dbp = prisma } = {}) {
    const row = await dbp.supportCase.findFirst({
      where: {
        OR: [{ id: caseId }, { reference: caseId }]
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            fullName: true,
            phone: true,
            tier: true,
            kycStatus: true,
            isBanned: true,
            createdAt: true
          }
        },
        notes: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    if (!row) throw new ResourceNotFoundError('Support case not found');

    const [relatedMatch, relatedWithdrawal, auditHistory] = await Promise.all([
      row.relatedMatchId
        ? dbp.match.findUnique({
          where: { id: row.relatedMatchId },
          select: {
            id: true,
            status: true,
            tier: true,
            stakeMinorUnits: true,
            winnerId: true,
            endReason: true,
            createdAt: true
          }
        })
        : Promise.resolve(null),
      row.relatedTransactionRef
        ? dbp.withdrawal.findFirst({
          where: {
            OR: [{ id: row.relatedTransactionRef }, { reference: row.relatedTransactionRef }]
          },
          select: {
            id: true,
            reference: true,
            amountMinorUnits: true,
            status: true,
            gateway: true,
            createdAt: true
          }
        })
        : Promise.resolve(null),
      dbp.adminAuditLog.findMany({
        where: {
          OR: [
            { targetType: 'support-case', targetId: row.id },
            { targetId: row.id }
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: 30
      })
    ]);

    return {
      supportCase: {
        ...row,
        user: row.user ?? null,
        notes: Array.isArray(row.notes) ? row.notes : [],
        relatedMatch: relatedMatch ? {
          ...relatedMatch,
          stakeMinorUnits: relatedMatch.stakeMinorUnits?.toString() ?? '0'
        } : null,
        relatedWithdrawal: relatedWithdrawal ? {
          ...relatedWithdrawal,
          amountMinorUnits: relatedWithdrawal.amountMinorUnits?.toString() ?? '0'
        } : null,
        auditHistory: auditHistory || []
      }
    };
  }

  static async createSupportCase({
    userId,
    subject,
    description,
    category = 'ACCOUNT',
    priority = 'MEDIUM',
    relatedMatchId = null,
    relatedTransactionRef = null,
    createdBy = null,
    dbp = prisma
  } = {}) {
    const user = await dbp.user.findUnique({ where: { id: userId } });
    if (!user) throw new UserNotFoundError();

    const reference = `SUP-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;

    return dbp.$transaction(async (tx) => {
      const created = await tx.supportCase.create({
        data: {
          reference,
          userId,
          subject: subject.trim(),
          description: description.trim(),
          category,
          priority,
          status: 'OPEN',
          relatedMatchId,
          relatedTransactionRef,
          createdBy
        }
      });

      await tx.supportCaseNote.create({
        data: {
          caseId: created.id,
          authorId: createdBy || 'system',
          eventType: 'CREATED',
          body: `Support case created with priority ${priority} in category ${category}.`
        }
      });

      return created;
    });
  }

  static async updateSupportCase({
    caseId,
    status,
    priority,
    assignedTo,
    resolutionNote,
    adminId,
    adminEmail,
    noteBody,
    dbp = prisma
  } = {}) {
    const existing = await dbp.supportCase.findUnique({ where: { id: caseId } });
    if (!existing) throw new ResourceNotFoundError('Support case not found');

    const dataToUpdate = {};
    const events = [];

    if (status && status !== existing.status) {
      dataToUpdate.status = status;
      if (status === 'RESOLVED' || status === 'CLOSED') {
        dataToUpdate.resolvedBy = adminId;
        dataToUpdate.resolvedAt = new Date();
        if (resolutionNote) dataToUpdate.resolutionNote = resolutionNote.trim();
      }
      events.push(`Status changed from ${existing.status} to ${status}`);
    }

    if (priority && priority !== existing.priority) {
      dataToUpdate.priority = priority;
      events.push(`Priority changed from ${existing.priority} to ${priority}`);
    }

    if (assignedTo !== undefined && assignedTo !== existing.assignedTo) {
      dataToUpdate.assignedTo = assignedTo;
      events.push(`Assigned to ${assignedTo || 'Unassigned'}`);
    }

    return dbp.$transaction(async (tx) => {
      const updated = await tx.supportCase.update({
        where: { id: caseId },
        data: dataToUpdate
      });

      if (events.length > 0 || noteBody) {
        const bodyContent = [
          events.join('; '),
          noteBody ? noteBody.trim() : null
        ].filter(Boolean).join('\n\n');

        await tx.supportCaseNote.create({
          data: {
            caseId,
            authorId: adminId || 'system',
            authorEmail: adminEmail || null,
            eventType: events.length > 0 ? 'STATUS_CHANGE' : 'NOTE',
            body: bodyContent
          }
        });
      }

      return updated;
    });
  }

  // =========================================================================
  // MODULE E: System Health & Integration Metrics
  // =========================================================================

  static async getSystemHealth({ dbp = prisma, redisClient = null } = {}) {
    const now = new Date();
    let dbStatus = 'ok';
    let dbLatencyMs = 0;
    try {
      const start = Date.now();
      await dbp.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - start;
    } catch (err) {
      dbStatus = 'failed';
    }

    let redisStatus = 'ok';
    let redisLatencyMs = 0;
    if (redisClient) {
      try {
        const start = Date.now();
        await redisClient.ping();
        redisLatencyMs = Date.now() - start;
      } catch (err) {
        redisStatus = 'failed';
      }
    } else {
      redisStatus = 'not_configured';
    }

    const [outboxPending, outboxFailed, recentAuditCount, activeMatchesCount] = await Promise.all([
      dbp.outboxEvent ? dbp.outboxEvent.count({ where: { status: 'PENDING' } }) : 0,
      dbp.outboxEvent ? dbp.outboxEvent.count({ where: { status: 'FAILED' } }) : 0,
      dbp.adminAuditLog ? dbp.adminAuditLog.count({
        where: { createdAt: { gte: new Date(now.getTime() - 3600_000) } }
      }) : 0,
      dbp.match ? dbp.match.count({ where: { status: { in: ['ACTIVE', 'IN_PLAY'] } } }) : 0
    ]);

    return {
      status: (dbStatus === 'ok' && redisStatus !== 'failed') ? 'HEALTHY' : 'DEGRADED',
      timestamp: now.toISOString(),
      services: {
        database: {
          status: dbStatus,
          provider: 'PostgreSQL',
          latencyMs: dbLatencyMs
        },
        cacheAndQueues: {
          status: redisStatus,
          provider: 'Redis',
          latencyMs: redisLatencyMs
        },
        outboxDrainer: {
          status: outboxFailed > 5 ? 'DEGRADED' : 'OPERATIONAL',
          pendingCount: outboxPending,
          failedCount: outboxFailed
        },
        gameSocketLayer: {
          status: 'OPERATIONAL',
          activeMatchesCount
        },
        paymentGateways: {
          paystack: { status: 'OPERATIONAL', mode: 'API_ROUTED' },
          flutterwave: { status: 'OPERATIONAL', mode: 'API_ROUTED' }
        }
      },
      metrics: {
        auditActionsLastHour: recentAuditCount,
        activeMatches: activeMatchesCount
      }
    };
  }

  /**
   * Admin money corrections. The ONLY sanctioned path to move a player's money
   * without a deposit/withdrawal/game event. Balanced double-entry, idempotent
   * per reference, and it writes the wallet.updated outbox row atomically so the
   * player's socket push fires exactly once.
   */
  static async postAdjustment({
    userId,
    amountMinorUnits,
    direction,
    reason = null,
    reference,
    actorId = null,
    currency = 'NGN'
  }) {
    return prisma.$transaction(async (tx) => {
      const { transaction } = await postAdjustment(tx, {
        userId,
        amountMinorUnits,
        direction,
        reason,
        reference,
        actorId,
        currency
      });

      await tx.wallet.upsert({
        where: { userId },
        create: { userId, currency },
        update: { currency }
      });
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      await enqueueWalletUpdated(tx, {
        userId,
        walletId: wallet.id,
        currency,
        type: 'ADJUSTMENT',
        amountMinorUnits,
        dedupeKey: `wallet:adjustment:${transaction.id}`
      });

      const available = await getLedgerAvailable(tx, userId, currency);
      return {
        transactionId: transaction.id,
        reference,
        direction,
        available: available.toString()
      };
    });
  }

  /**
   * Lists player balance top-up attempts (`DepositIntent`) with user attribution,
   * gateway, reference, and completion timestamps for admin traceability.
   */
  static async listDeposits({ page = 1, limit = 20, status, gateway, userId, search, dbp = prisma } = {}) {
    const VALID_STATUSES = new Set(['PENDING', 'COMPLETED', 'FAILED']);
    const VALID_GATEWAYS = new Set(['PAYSTACK', 'FLUTTERWAVE']);

    const where = {};
    if (typeof status === 'string' && VALID_STATUSES.has(status.trim().toUpperCase())) {
      where.status = status.trim().toUpperCase();
    }
    if (typeof gateway === 'string' && VALID_GATEWAYS.has(gateway.trim().toUpperCase())) {
      where.gateway = gateway.trim().toUpperCase();
    }
    if (typeof userId === 'string' && userId.trim()) {
      where.userId = userId.trim();
    }
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { reference: { contains: term, mode: 'insensitive' } },
        { userId: { contains: term, mode: 'insensitive' } },
        { user: { email: { contains: term, mode: 'insensitive' } } },
        { user: { username: { contains: term, mode: 'insensitive' } } }
      ];
    }

    const skip = (page - 1) * limit;
    const [rows, total, completedAgg, statusCounts] = await Promise.all([
      dbp.depositIntent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: { id: true, email: true, username: true, fullName: true, tier: true }
          }
        }
      }),
      dbp.depositIntent.count({ where }),
      dbp.depositIntent.aggregate({
        where: { ...where, status: 'COMPLETED' },
        _sum: { amountMinorUnits: true },
        _count: { _all: true }
      }),
      dbp.depositIntent.groupBy({
        by: ['status'],
        where,
        _count: { _all: true }
      })
    ]);

    const countsByStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));

    const deposits = rows.map((d) => ({
      id: d.id,
      userId: d.userId,
      walletId: d.walletId,
      gateway: d.gateway,
      reference: d.reference,
      amountMinorUnits: d.amountMinorUnits.toString(),
      currency: d.currency,
      status: d.status,
      appliedAt: d.appliedAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      user: d.user
    }));

    return {
      deposits,
      summary: {
        totalCount: total,
        completedCount: countsByStatus.COMPLETED ?? 0,
        pendingCount: countsByStatus.PENDING ?? 0,
        failedCount: countsByStatus.FAILED ?? 0,
        completedVolumeMinorUnits: (completedAgg._sum?.amountMinorUnits ?? 0n).toString()
      },
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }

  /**
   * Lists immutable double-entry `LedgerTransaction`s with optional withdrawal exclusion
   * (default `excludeWithdrawals=true` to inspect deposits, match stakes, releases, payouts,
   * and admin adjustments).
   */
  static async listLedgerTransactions({
    page = 1,
    limit = 20,
    type,
    excludeWithdrawals = true,
    userId,
    matchId,
    search,
    dbp = prisma
  } = {}) {
    const VALID_TYPES = new Set([
      'DEPOSIT_CREDIT',
      'STAKE_LOCK',
      'STAKE_RELEASE',
      'SETTLEMENT_PAYOUT',
      'WITHDRAWAL_RESERVE',
      'WITHDRAWAL_COMPLETE',
      'WITHDRAWAL_RELEASE',
      'ADJUSTMENT'
    ]);
    const WITHDRAWAL_TYPES = ['WITHDRAWAL_RESERVE', 'WITHDRAWAL_COMPLETE', 'WITHDRAWAL_RELEASE'];

    const where = {};
    if (typeof type === 'string' && VALID_TYPES.has(type.trim().toUpperCase())) {
      where.type = type.trim().toUpperCase();
    } else if (excludeWithdrawals) {
      where.type = { notIn: WITHDRAWAL_TYPES };
    }

    if (typeof matchId === 'string' && matchId.trim()) {
      where.relatedMatchId = matchId.trim();
    }
    if (typeof userId === 'string' && userId.trim()) {
      where.entries = { some: { account: { userId: userId.trim() } } };
    }
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { id: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { idempotencyKey: { contains: term, mode: 'insensitive' } },
        { relatedMatchId: { contains: term, mode: 'insensitive' } },
        { entries: { some: { account: { user: { email: { contains: term, mode: 'insensitive' } } } } } },
        { entries: { some: { account: { user: { username: { contains: term, mode: 'insensitive' } } } } } }
      ];
    }

    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      dbp.ledgerTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          entries: {
            include: {
              account: {
                select: {
                  id: true,
                  type: true,
                  currency: true,
                  userId: true,
                  user: {
                    select: { id: true, email: true, username: true, tier: true }
                  }
                }
              }
            }
          }
        }
      }),
      dbp.ledgerTransaction.count({ where })
    ]);

    const transactions = rows.map((tx) => {
      let net = 0n;
      let positiveVolume = 0n;
      const seenUsers = new Map();

      const entries = (tx.entries || []).map((e) => {
        const amt = BigInt(e.amountMinorUnits);
        net += amt;
        if (amt > 0n) positiveVolume += amt;
        if (e.account?.user) {
          seenUsers.set(e.account.user.id, e.account.user);
        }
        return {
          id: e.id,
          accountId: e.accountId,
          accountType: e.account?.type ?? 'UNKNOWN',
          currency: e.account?.currency ?? 'NGN',
          userId: e.account?.userId ?? null,
          user: e.account?.user ?? null,
          amountMinorUnits: amt.toString(),
          createdAt: e.createdAt
        };
      });

      return {
        id: tx.id,
        type: tx.type,
        description: tx.description,
        idempotencyKey: tx.idempotencyKey,
        relatedMatchId: tx.relatedMatchId,
        metadata: tx.metadata,
        createdAt: tx.createdAt,
        totalVolumeMinorUnits: positiveVolume.toString(),
        netMinorUnits: net.toString(),
        balanced: net === 0n && entries.length >= 2,
        users: [...seenUsers.values()],
        entries
      };
    });

    return {
      transactions,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }
}
