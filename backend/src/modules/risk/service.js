import prisma from '../../utils/db.js';

// Risk review surface for RISK_COMPLIANCE / SUPER_ADMIN. Reads stream from the
// risk event log and the manual case queue; status updates are the only
// mutation (assignment + status transitions), fully audited by the controller.

export const RISK_CASE_STATUS_LIST = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];

export class RiskCaseNotFoundError extends Error {
  constructor(message = 'Risk case not found') {
    super(message);
    this.name = 'RiskCaseNotFoundError';
  }
}

export const listRiskEvents = async ({ page, limit, type = null, severity = null, userId = null }) => {
  const where = {
    ...(typeof userId === 'string' && userId ? { userId } : {}),
    ...(typeof type === 'string' && type ? { type } : {}),
    ...(typeof severity === 'string' && severity ? { severity } : {})
  };
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    prisma.riskEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.riskEvent.count({ where })
  ]);
  return { events: rows, total, page, totalPages: Math.ceil(total / limit) };
};

export const listRiskCases = async ({ page, limit, status = null }) => {
  const where = typeof status === 'string' && RISK_CASE_STATUS_LIST.includes(status) ? { status } : {};
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    prisma.riskCase.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take: limit }),
    prisma.riskCase.count({ where })
  ]);
  return { cases: rows, total, page, totalPages: Math.ceil(total / limit) };
};

export const updateRiskCaseStatus = async (caseId, { status, assignedTo = null }) => {
  const existing = await prisma.riskCase.findUnique({ where: { id: caseId } });
  if (!existing) throw new RiskCaseNotFoundError();
  return prisma.riskCase.update({
    where: { id: caseId },
    data: {
      status,
      ...(typeof assignedTo === 'string' ? { assignedTo } : {})
    }
  });
};