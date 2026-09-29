// Stand-in Paystack for driving the deposit and withdrawal screens against a
// real backend.
//
// The backend's PaystackGateway reaches whatever PAYSTACK_API_BASE points at,
// so pointing it here keeps every real code path (quote, intent, signature
// verification, webhook crediting) intact while the hosted checkout resolves to
// a local page instead of the live provider.
//
// The payout half matters just as much: bank-account verification, recipient
// creation and transfer initiation are all gated on the provider answering, so
// without /bank/resolve, /transferrecipient and /transfer the withdrawal
// screens cannot be recorded against the real backend at all. Settling a
// transfer delivers a real signed transfer.success / transfer.failed webhook,
// so the backend's own payout handler drives the status screens rather than a
// test writing to the database.
//
//   PAYSTACK_API_BASE=http://127.0.0.1:4010 PAYSTACK_SECRET_KEY=<key> \
//     node scripts/fake-paystack.mjs
//
// The checkout page is opened by the emulator at PUBLIC_HOST (10.0.2.2), while
// the webhook is delivered to the backend over loopback.
import crypto from 'crypto';
import http from 'http';

const PORT = Number(process.env.FAKE_PAYSTACK_PORT || 4010);
const SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const WEBHOOK_TARGET =
  process.env.FAKE_PAYSTACK_WEBHOOK ||
  'http://127.0.0.1:3000/webhooks/paystack';
// Reachable from the Android emulator, which reaches the host through 10.0.2.2.
const PUBLIC_HOST = process.env.FAKE_PAYSTACK_PUBLIC_HOST || '10.0.2.2';

if (!SECRET) {
  console.error('PAYSTACK_SECRET_KEY must match the backend so the HMAC verifies');
  process.exit(2);
}

// reference -> everything the webhook needs to echo back to the backend.
const sessions = new Map();

// Payouts need the same treatment on the way out: the backend refuses to show
// a bank account as verified, or to move money, without a real recipient code
// and a real transfer code, so the stand-in has to answer the Transfers API too.
const transfers = new Map();
const recipients = new Map();
// A real provider's transfer codes are unique for the life of the account, not
// just the life of a process. Countering from 1 on every restart reissued
// TRF_fake_1 and collided with Withdrawal.providerRef's unique constraint, so
// the prefix carries the start time.
const RUN_TAG = Date.now().toString(36);
let transferSeq = 0;
let recipientSeq = 0;

const log = (...args) => console.log('[fake-paystack]', ...args);

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

/**
 * Mirrors Paystack: the signature is an HMAC-SHA512 of the exact bytes we send,
 * so the backend's verification runs for real against a stand-in body.
 */
const deliverWebhook = async (session, event) => {
  const body = JSON.stringify({
    event,
    data: {
      id: 900000 + sessions.size,
      reference: session.reference,
      amount: Number(session.amountMinorUnits),
      currency: session.currency || 'NGN',
      status: 'success',
      paid_at: new Date().toISOString(),
      channel: 'test',
      gateway_response: 'Successful',
      metadata: { userId: session.userId },
    },
  });
  const signature = crypto
    .createHmac('sha512', SECRET)
    .update(body)
    .digest('hex');

  const response = await fetch(WEBHOOK_TARGET, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-paystack-signature': signature,
    },
    body,
  });
  const text = await response.text().catch(() => '');
  log(`webhook ${event} -> ${WEBHOOK_TARGET} ${response.status} ${text}`);
  return response.status;
};

/**
 * The payout twin of the charge webhook: same real HMAC, same real event
 * router. `reference` is OURS, which is exactly how the backend matches an
 * incoming transfer event back to a withdrawal row, so the drive never has to
 * guess an id.
 */
const deliverTransferWebhook = async (transfer, outcome) => {
  const succeeded = outcome !== 'failure';
  const body = JSON.stringify({
    event: succeeded ? 'transfer.success' : 'transfer.failed',
    data: {
      id: 910000 + transfers.size,
      reference: transfer.reference,
      transfer_code: transfer.transferCode,
      status: succeeded ? 'success' : 'failed',
      amount: transfer.amount,
      currency: transfer.currency || 'NGN',
      recipient: transfer.recipient,
      source: 'balance',
      transferred_at: succeeded ? new Date().toISOString() : null,
      // The backend reads this for the player-facing failure copy.
      ...(succeeded ? {} : { complete_message: 'Insufficient balance in payout source account' }),
    },
  });
  const signature = crypto
    .createHmac('sha512', SECRET)
    .update(body)
    .digest('hex');

  const response = await fetch(WEBHOOK_TARGET, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-paystack-signature': signature,
    },
    body,
  });
  const text = await response.text().catch(() => '');
  log(
    `transfer webhook ${succeeded ? 'transfer.success' : 'transfer.failed'} ref=${transfer.reference} ` +
      `-> ${WEBHOOK_TARGET} ${response.status} ${text}`
  );
  return response.status;
};

const checkoutPage = (session) => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Paystack Test Checkout</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #f5f6f8; margin: 0;
             display: flex; justify-content: center; padding: 40px 20px; }
      .card { background: #fff; border-radius: 14px; padding: 28px; width: 100%;
              max-width: 380px; box-shadow: 0 8px 28px rgba(0,0,0,.10); }
      h1 { font-size: 19px; margin: 0 0 6px; color: #0f1f3d; }
      .amount { font-size: 30px; font-weight: 700; color: #00c4b3; margin: 18px 0; }
      .row { display: flex; justify-content: space-between; font-size: 13px;
             color: #5b6478; padding: 7px 0; border-bottom: 1px solid #eef0f4; }
      .ref { font-family: ui-monospace, monospace; font-size: 11px; color: #8992a6;
             word-break: break-all; margin-top: 14px; }
      button { width: 100%; margin-top: 22px; padding: 15px; border: 0;
               border-radius: 9px; background: #00c4b3; color: #fff;
               font-size: 16px; font-weight: 600; }
      button:disabled { background: #9aa4b8; }
      .done { margin-top: 18px; padding: 12px; border-radius: 9px; font-size: 13px; }
      .ok { background: #e6f7f4; color: #067a6f; }
      .bad { background: #fdeaea; color: #a11; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Paystack Test Checkout</h1>
      <div class="amount">₦${(Number(session.amountMinorUnits) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</div>
      <div class="row"><span>Reference</span><span>test drive</span></div>
      <div class="row"><span>Channel</span><span>Card (simulated)</span></div>
      <div class="ref">${session.reference}</div>
      <button id="pay">Pay ₦${(Number(session.amountMinorUnits) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</button>
      <div id="result"></div>
    </div>
    <script>
      const reference = ${JSON.stringify(session.reference)};
      const btn = document.getElementById('pay');
      const out = document.getElementById('result');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Processing…';
        let ok = false;
        try {
          const res = await fetch(
            '/checkout/pay?reference=' + encodeURIComponent(reference),
            { method: 'POST' },
          );
          const data = await res.json();
          ok = !!data.ok;
          out.className = 'done ' + (ok ? 'ok' : 'bad');
          out.textContent = ok
            ? 'Payment successful. You can close this window.'
            : 'Payment could not be delivered: ' + (data.error || 'unknown error');
        } catch (err) {
          out.className = 'done bad';
          out.textContent = 'Network error: ' + err;
        }
        btn.textContent = ok ? 'Paid' : 'Try again';
        if (!ok) btn.disabled = false;
      });
    </script>
  </body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // Paystack transaction initialisation.
    if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
      const reference = payload.reference || `fake_${Date.now()}`;
      sessions.set(reference, {
        reference,
        userId: payload.metadata?.userId,
        amountMinorUnits: payload.amount,
        currency: payload.currency,
        email: payload.email,
      });
      log(`initialize ref=${reference} amount=${payload.amount}`);
      return json(res, 200, {
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: `http://${PUBLIC_HOST}:${PORT}/checkout?reference=${encodeURIComponent(reference)}`,
          access_code: 'test_access_code',
          reference,
        },
      });
    }

    // The hosted checkout page the in-app webview loads.
    if (req.method === 'GET' && url.pathname === '/checkout') {
      const reference = url.searchParams.get('reference');
      const session = sessions.get(reference);
      if (!session) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<h1>Unknown checkout reference</h1>');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(checkoutPage(session));
    }

    // The "Pay" button: deliver a genuinely signed charge.success webhook.
    if (req.method === 'POST' && url.pathname === '/checkout/pay') {
      const reference =
        url.searchParams.get('reference') || [...sessions.keys()].pop();
      const session = sessions.get(reference);
      if (!session) return json(res, 400, { ok: false, error: 'unknown reference' });
      if (!session.userId) {
        return json(res, 400, { ok: false, error: 'session has no userId metadata' });
      }
      const status = await deliverWebhook(session, 'charge.success');
      return json(res, status === 200 ? 200 : 502, {
        ok: status === 200,
        ...(status === 200 ? {} : { error: `backend responded ${status}` }),
      });
    }

    // Lets the drive test confirm a payment without touching the webview.
    if (req.method === 'POST' && url.pathname === '/test/confirm') {
      const reference = url.searchParams.get('reference') || [...sessions.keys()].pop();
      const session = sessions.get(reference);
      if (!session) return json(res, 400, { ok: false, error: 'unknown reference' });
      const status = await deliverWebhook(session, 'charge.success');
      return json(res, 200, { ok: status === 200, reference, status });
    }

    if (req.method === 'GET' && url.pathname === '/test/sessions') {
      return json(res, 200, { sessions: [...sessions.values()] });
    }

    // ---------------------------------------------------------------------
    // Payouts (Transfers API). The backend's bank-account and payout paths are
    // otherwise unreachable without live Paystack keys, so the withdrawal
    // screens could only be recorded against mocks until this existed.
    // ---------------------------------------------------------------------

    // Nuban resolution. A real one echoes the account holder's name, which is
    // what the review screen displays as the destination.
    if (req.method === 'GET' && url.pathname === '/bank/resolve') {
      const accountNumber = url.searchParams.get('account_number');
      const bankCode = url.searchParams.get('bank_code');
      if (!accountNumber) {
        return json(res, 400, { status: false, message: 'account_number is required' });
      }
      log(`resolve account=${accountNumber} bank=${bankCode}`);
      return json(res, 200, {
        status: true,
        message: 'Account resolved',
        data: {
          account_number: accountNumber,
          account_name: process.env.FAKE_PAYSTACK_ACCOUNT_NAME || 'DRAUGHTS ARENA PLAYER',
          bank_code: bankCode,
        },
      });
    }

    // Reusable transfer recipient, created once when a bank account is saved.
    if (req.method === 'POST' && url.pathname === '/transferrecipient') {
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
      if (!payload.account_number || !payload.name) {
        return json(res, 400, { status: false, message: 'name and account_number are required' });
      }
      // Real Paystack is idempotent on (name, account_number): saving the same
      // account twice must return the same code, and the backend relies on that
      // to keep one recipient per stored bank account.
      const key = `${payload.name}:${payload.account_number}`;
      let recipientCode = recipients.get(key);
      const reused = Boolean(recipientCode);
      if (!recipientCode) {
        recipientCode = `RCP_fake_${RUN_TAG}_${++recipientSeq}`;
        recipients.set(key, recipientCode);
      }
      log(`recipient ${payload.account_number} -> ${recipientCode}${reused ? ' (reused)' : ''}`);
      return json(res, 200, {
        status: true,
        message: 'Transfer recipient created',
        data: {
          recipient_code: recipientCode,
          type: payload.type,
          name: payload.name,
          account_number: payload.account_number,
          bank_code: payload.bank_code,
          currency: payload.currency || 'NGN',
        },
      });
    }

    // Transfer initiation. The reference is ours and is what the settle hook
    // later echoes, so the webhook route can find the withdrawal unaided.
    if (req.method === 'POST' && url.pathname === '/transfer') {
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
      if (!payload.reference || !payload.recipient) {
        return json(res, 400, { status: false, message: 'reference and recipient are required' });
      }
      const transferCode = `TRF_fake_${RUN_TAG}_${++transferSeq}`;
      transfers.set(payload.reference, {
        reference: payload.reference,
        transferCode,
        amount: Number(payload.amount),
        currency: payload.currency || 'NGN',
        recipient: payload.recipient,
        settled: false,
        outcome: null,
      });
      log(`transfer ref=${payload.reference} amount=${payload.amount} -> ${transferCode}`);
      return json(res, 200, {
        status: true,
        message: 'Transfer queued',
        data: {
          transfer_code: transferCode,
          reference: payload.reference,
          status: 'queued',
          amount: Number(payload.amount),
          currency: payload.currency || 'NGN',
          recipient: payload.recipient,
        },
      });
    }

    // Transfer status lookup. The recovery sweep in src/jobs/providerFollowUp.js
    // calls this for any payout that stayed PROCESSING, so without it the sweep
    // cannot reconcile a stuck withdrawal against this double.
    if (req.method === 'GET' && url.pathname.startsWith('/transfer/verify/')) {
      const key = decodeURIComponent(url.pathname.slice('/transfer/verify/'.length));
      const transfer =
        [...transfers.values()].find(
          (t) => t.transferCode === key || t.reference === key
        );
      if (!transfer) {
        return json(res, 404, { status: false, message: 'transfer not found' });
      }
      // An unsettled transfer is still in flight; a settled one reports the
      // outcome it was settled with.
      const status = !transfer.settled ? 'queued' : transfer.outcome;
      log(`verify ${key} -> ${status}`);
      return json(res, 200, {
        status: true,
        message: 'Transfer retrieved',
        data: {
          transfer_code: transfer.transferCode,
          reference: transfer.reference,
          status,
          amount: transfer.amount,
          currency: transfer.currency || 'NGN',
          recipient: transfer.recipient,
        },
      });
    }

    // Lets the drive test settle the newest (or named) transfer by delivering a
    // genuinely signed transfer.success / transfer.failed webhook, so the
    // backend's own payout handler is what moves the screen forward.
    if (req.method === 'POST' && url.pathname === '/test/transfer/settle') {
      const outcome = url.searchParams.get('outcome') || 'success';
      if (!['success', 'failure'].includes(outcome)) {
        return json(res, 400, { ok: false, error: 'outcome must be success or failure' });
      }
      const reference =
        url.searchParams.get('reference') ||
        // Prefer the newest transfer nobody has settled yet. Picking the newest
        // outright would re-settle an earlier run's transfer once a drive leaves
        // one behind, and the player would see a payout they never requested.
        [...transfers.values()].reverse().find((t) => !t.settled)?.reference;
      const transfer = transfers.get(reference);
      if (!transfer) return json(res, 400, { ok: false, error: 'unknown transfer reference' });
      const status = await deliverTransferWebhook(transfer, outcome);
      transfer.settled = true;
      transfer.outcome = outcome;
      return json(res, 200, {
        ok: status === 200,
        reference,
        transferCode: transfer.transferCode,
        outcome,
        status,
      });
    }

    if (req.method === 'GET' && url.pathname === '/test/transfers') {
      return json(res, 200, { transfers: [...transfers.values()] });
    }

    return json(res, 404, { message: 'not found' });
  } catch (error) {
    log('error', error);
    return json(res, 500, { message: error.message });
  }
});

server.listen(PORT, () => {
  log(`listening on ${PORT}; emulator reaches it at ${PUBLIC_HOST}:${PORT}`);
  log(`webhook target ${WEBHOOK_TARGET}`);
});
