/**
 * High-Stakes Wallet & Financial Ledger Scenario
 * Funds synthetic accounts scaled by tier (`AMATEUR`: NGN 25,000, `MASTER`: NGN 300,000,
 * `PRO`: NGN 1,000,000) via deposit-intent + signed mock Paystack webhooks, links bank
 * accounts, submits high-value withdrawal requests, and inspects transaction history.
 */
import crypto from 'node:crypto';
import { createPaystackMockSignature } from '../simGuard.js';

const TARGET_BANKROLL_BY_TIER = Object.freeze({
  AMATEUR: 2_500_000n,    // NGN 25,000
  MASTER: 30_000_000n,    // NGN 300,000
  PRO: 100_000_000n       // NGN 1,000,000
});

const WITHDRAWAL_BY_TIER = Object.freeze({
  AMATEUR: '25000',       // NGN 250
  MASTER: '500000',       // NGN 5,000
  PRO: '2500000'          // NGN 25,000
});

export async function runWalletFinancialScenario(runner, userState) {
  userState.currentActivity = 'WALLET_FINANCIAL';

  const balRes = await runner.apiCall(userState, 'GET', '/wallet/balance');
  await runner.apiCall(userState, 'GET', '/wallet/tier-limits');

  const tier = userState.targetTier || 'AMATEUR';
  const targetBankroll = TARGET_BANKROLL_BY_TIER[tier] ?? 2_500_000n;
  const currentAvailable = BigInt(
    balRes.json?.balance?.availableMinorUnits ?? balRes.json?.wallet?.availableMinorUnits ?? '0'
  );

  if (currentAvailable < targetBankroll) {
    const amountMinorUnits = targetBankroll.toString();
    const intentRes = await runner.apiCall(
      userState,
      'POST',
      '/wallet/deposit-intent',
      {
        body: {
          amountMinorUnits,
          gateway: 'paystack'
        }
      },
      [200, 201, 403]
    );

    const reference = intentRes.json?.reference || intentRes.json?.intent?.reference;
    if ((intentRes.status === 200 || intentRes.status === 201) && reference) {
      const webhookPayload = JSON.stringify({
        event: 'charge.success',
        data: {
          reference,
          amount: Number(amountMinorUnits),
          currency: 'NGN',
          metadata: {
            userId: userState.userId
          }
        }
      });
      const sig = createPaystackMockSignature(webhookPayload);
      await runner.rawRequest(userState, 'POST', '/webhooks/paystack', {
        baseRoot: true,
        rawBody: webhookPayload,
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': sig
        },
        expectedStatuses: [200]
      });
      if (userState.index <= 25 || tier === 'PRO') {
        runner.logActivity(`${userState.label} [${tier}] deposited +${amountMinorUnits} minor units`, {
          userIndex: userState.index,
          event: 'wallet.deposit',
          reference
        });
      }
    }
  }

  const banksRes = await runner.apiCall(userState, 'GET', '/wallet/bank-accounts');
  const existingBanks = banksRes.json?.bankAccounts ?? [];
  if (existingBanks.length === 0) {
    const suffix = String(10000000 + userState.index).slice(-8);
    await runner.apiCall(
      userState,
      'POST',
      '/wallet/bank-accounts',
      {
        body: {
          gateway: 'paystack',
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: `01${suffix}`
        }
      },
      [201, 409, 422]
    );
  }

  if (userState.index % 5 === 0) {
    const runTag = runner.runId || userState.runId || 'sim';
    const wdAmount = WITHDRAWAL_BY_TIER[tier] ?? '25000';
    const idempotencyKey = `sim-${runTag}-wd-${userState.index}-${crypto.randomUUID().slice(0, 8)}`;
    const wdRes = await runner.apiCall(
      userState,
      'POST',
      '/wallet/withdrawal-request',
      {
        body: {
          amountMinorUnits: wdAmount,
          idempotencyKey
        }
      },
      [201, 402, 403, 422]
    );
    if (wdRes.status === 201 && (userState.index <= 40 || tier === 'PRO')) {
      runner.logActivity(`${userState.label} [${tier}] requested withdrawal (${wdAmount} minor units)`, {
        userIndex: userState.index,
        event: 'wallet.withdrawal_request'
      });
    }
  }

  await runner.apiCall(userState, 'GET', '/wallet/transactions?page=1&limit=10');
  await runner.apiCall(userState, 'GET', '/wallet/withdrawals?page=1&limit=10');

  userState.completedWorkflows += 1;
  userState.currentActivity = 'IDLE';
  return { ok: true };
}
