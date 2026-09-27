// Stand-in Paystack for driving the deposit screens against a real backend.
//
// The backend's PaystackGateway reaches whatever PAYSTACK_API_BASE points at,
// so pointing it here keeps every real code path (quote, intent, signature
// verification, webhook crediting) intact while the hosted checkout resolves to
// a local page instead of the live provider.
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
