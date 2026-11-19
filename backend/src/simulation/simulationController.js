/**
 * Dev-Gated Admin Simulation Controller
 * Exposes start/pause/resume/stop/reset/status/reconcile endpoints strictly when
 * NODE_ENV === 'development' && SIMULATION_ENABLED === 'true' and DATABASE_URL
 * passes isolated local/dev environment validation.
 */
import express from 'express';
import { PERMISSIONS } from '../modules/rbac/permissions.js';
import { requirePermission } from '../modules/rbac/service.js';
import { recordAdminAction } from '../modules/audit/service.js';
import { runFinancialReconciliation } from '../jobs/financialReconciliation.js';
import { sharedSimulationRunner } from './SimulationRunner.js';
import { assertSafeSimulationEnvironment } from './simGuard.js';

export const simulationRouter = express.Router();

const auditSim = (req, action, metadata = null) =>
  recordAdminAction({
    adminId: req.user.id,
    action,
    outcome: 'SUCCESS',
    targetType: 'simulation',
    targetId: 'platform-simulation',
    metadata,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id
  });

const requireSimulationDevGate = (_req, res, next) => {
  if (process.env.NODE_ENV !== 'development' || process.env.SIMULATION_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    assertSafeSimulationEnvironment();
    return next();
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
};

simulationRouter.use(requirePermission(PERMISSIONS.ROLES_ADMIN));

simulationRouter.get('/status', requireSimulationDevGate, (_req, res) => {
  res.json({ simulation: sharedSimulationRunner.getStatus() });
});

simulationRouter.post('/start', requireSimulationDevGate, async (req, res, next) => {
  try {
    const authHeader = req.get('authorization') || '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : null;

    const { runId, userCount, concurrency, durationMs, actionIntervalMs, scenarios, baseOrigin, simPassword } = req.body ?? {};
    const status = await sharedSimulationRunner.start({
      runId,
      userCount,
      concurrency,
      durationMs,
      actionIntervalMs,
      scenarios,
      baseOrigin,
      simPassword,
      adminAccessToken: bearerToken
    });
    await auditSim(req, 'simulation.start', {
      userCount: status.config.userCount,
      concurrency: status.config.concurrency,
      scenarios: status.config.scenarios
    });
    res.status(202).json({ simulation: status });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

simulationRouter.post('/pause', requireSimulationDevGate, async (req, res, next) => {
  try {
    const status = sharedSimulationRunner.pause();
    await auditSim(req, 'simulation.pause', { status: status.status });
    res.json({ simulation: status });
  } catch (err) {
    next(err);
  }
});

simulationRouter.post('/resume', requireSimulationDevGate, async (req, res, next) => {
  try {
    const status = sharedSimulationRunner.resume();
    await auditSim(req, 'simulation.resume', { status: status.status });
    res.json({ simulation: status });
  } catch (err) {
    next(err);
  }
});

simulationRouter.post('/stop', requireSimulationDevGate, async (req, res, next) => {
  try {
    const status = await sharedSimulationRunner.stop();
    await auditSim(req, 'simulation.stop', { status: status.status });
    res.json({ simulation: status });
  } catch (err) {
    next(err);
  }
});

simulationRouter.post('/reset', requireSimulationDevGate, async (req, res, next) => {
  try {
    const requestedRunId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : null;
    const summary = await sharedSimulationRunner.resetFixtures(requestedRunId);
    await auditSim(req, 'simulation.reset', summary);
    res.json({ summary, simulation: sharedSimulationRunner.getStatus() });
  } catch (err) {
    if (err.message?.includes('requires a valid explicit runId')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

simulationRouter.post('/reconcile', requireSimulationDevGate, async (req, res, next) => {
  try {
    const run = await runFinancialReconciliation();
    await auditSim(req, 'simulation.reconcile', {
      runId: run.id,
      status: run.status,
      discrepancyCount: Array.isArray(run.discrepancies) ? run.discrepancies.length : 0
    });
    res.json({ reconciliationRun: run });
  } catch (err) {
    next(err);
  }
});
