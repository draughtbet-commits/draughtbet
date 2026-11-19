#!/usr/bin/env node
/**
 * 20-User Draught Bet Simulation CLI Runner
 *
 * Supports isolated local PostgreSQL OR explicitly permitted Neon simulation
 * (`SIMULATION_ALLOW_NEON=true` + `SIMULATION_MOCK_PAYMENTS=true`), with local Redis.
 */
import dotenv from 'dotenv';
import { SimulationRunner } from '../src/simulation/SimulationRunner.js';
import { assertSafeSimulationEnvironment } from '../src/simulation/simGuard.js';
import prisma from '../src/utils/db.js';

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [k, v = 'true'] = raw.slice(2).split('=');
    args[k] = v;
  }
  return args;
}

const cliArgs = parseArgs(process.argv.slice(2));
dotenv.config({ path: cliArgs.env || process.env.DOTENV_CONFIG_PATH || '.env.sim', override: true });

async function main() {
  assertSafeSimulationEnvironment();

  const runner = new SimulationRunner({
    baseOrigin: cliArgs.baseUrl || process.env.SIMULATION_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`
  });

  if (cliArgs.reset === 'true') {
    const cleaned = await runner.resetFixtures(cliArgs.runId);
    console.log('[simulation] Run-scoped reset:', JSON.stringify(cleaned));
    if (cliArgs.onlyReset === 'true') return;
  }

  let adminAccessToken = process.env.SIMULATION_ADMIN_TOKEN || null;
  if (!adminAccessToken && process.env.SIMULATION_ADMIN_EMAIL && process.env.SIMULATION_ADMIN_PASSWORD) {
    const res = await fetch(`${runner.baseOrigin}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-app-version': '2.1.0'
      },
      body: JSON.stringify({
        email: process.env.SIMULATION_ADMIN_EMAIL,
        password: process.env.SIMULATION_ADMIN_PASSWORD
      })
    });
    if (res.ok) {
      const json = await res.json();
      adminAccessToken = json.accessToken || null;
    }
  }

  const report = await runner.start(
    {
      runId: cliArgs.runId,
      userCount: cliArgs.users ? Number(cliArgs.users) : 20,
      concurrency: cliArgs.concurrency ? Number(cliArgs.concurrency) : 5,
      durationMs: cliArgs.durationMs ? Number(cliArgs.durationMs) : 60_000,
      actionIntervalMs: cliArgs.intervalMs ? Number(cliArgs.intervalMs) : 600,
      scenarios: cliArgs.scenarios ? cliArgs.scenarios.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      adminAccessToken
    },
    { waitForCompletion: true }
  );

  console.log('\n=== Draught Bet 20-User Simulation Report ===');
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    metrics: report.metrics,
    gaps: report.gaps
  }, null, 2));
}

main()
  .catch((err) => {
    console.error('[simulation] Fatal error:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
