import express from 'express';

export const paymentsRouter = express.Router();

// The app's custom URL scheme. The checkout WebView intercepts this navigation
// and closes itself; an external browser hands it to the OS to launch the app.
const APP_RETURN_DEEPLINK = 'draughts://app/payment/callback';

// Public landing page the payment provider redirects the player to once the
// hosted checkout is done. It is deliberately free of any success claim: the
// return is only a signal to leave checkout, and the app then reads the
// authoritative deposit status from the API. Rendered as a small self-contained
// document (no external assets) so it works inside a WebView and a browser,
// then bounces to the app scheme.
const returnPage = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${APP_RETURN_DEEPLINK}">
<title>Returning to Draught Bet</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    background: #0b0f0c; color: #f2f5f3;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .card { width: 100%; max-width: 360px; text-align: center; }
  .badge {
    width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 34px; font-weight: 700; color: #0b0f0c;
    background: #37d67a;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 22px; color: #a7b0aa; font-size: 14px; line-height: 1.5; }
  a {
    display: inline-block; padding: 12px 22px; border-radius: 10px;
    background: #37d67a; color: #0b0f0c; font-weight: 600;
    text-decoration: none; font-size: 14px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">&#10003;</div>
    <h1>Returning to Draught Bet</h1>
    <p>Your payment has been submitted. We are checking it with the provider &mdash;
    your wallet updates only once the server confirms it.</p>
    <a href="${APP_RETURN_DEEPLINK}">Open the app</a>
  </div>
</body>
</html>`;

paymentsRouter.get('/return', (_req, res) => {
  res.status(200).type('html').send(returnPage());
});
