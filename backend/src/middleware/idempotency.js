import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { parseIdempotencyKey } from '../modules/wallet/service.js';

// HTTP-layer idempotency for state-changing requests. The client supplies an
// Idempotency-Key header (8-128 chars of [A-Za-z0-9._:-]); the first request
// runs the handler, its successful response is cached, and any retry with the
// same key is answered with the cached response instead of re-running the
// operation. This is a SEPARATE layer from the per-aggregate idempotency keys
// the ledger/withdrawal services keep internally (e.g. ledger references).

const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS_GRACE_MS = 60 * 1000;

const claimKeyFor = (req) => {
  const path = `${req.baseUrl || ''}${req.path || ''}`;
  return { scope: `admin:${req.method}${path}`, key: `admin:${req.method}${path}:${req.get('idempotency-key')}` };
};

export const requireIdempotencyKey = async (req, res, next) => {
  if (req.method !== 'POST') return next();

  const raw = req.get('idempotency-key');
  let parsed;
  try {
    parsed = parseIdempotencyKey(raw);
  } catch (error) {
    return res.status(400).json({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: error.message } });
  }
  if (!parsed) {
    return res.status(400).json({
      error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required for POST requests' }
    });
  }

  const { scope, key } = claimKeyFor(req);

  try {
    const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
    if (existing) {
      if (existing.result) {
        const cached = existing.result;
        return res.status(cached.status).json(cached.body);
      }
      const ageMs = Date.now() - new Date(existing.createdAt).getTime();
      if (ageMs < IN_PROGRESS_GRACE_MS) {
        return res.status(409).json({
          error: { code: 'DUPLICATE_OPERATION', message: 'Another request with this idempotency key is already in progress' }
        });
      }
      // Stale in-progress claim (crashed before responding) — reclaim it.
      await prisma.idempotencyRecord.delete({ where: { key } });
    }

    try {
      await prisma.idempotencyRecord.create({
        data: { key, scope, expiresAt: new Date(Date.now() + RESULT_TTL_MS) }
      });
    } catch (error) {
      if (error?.code === 'P2002') {
        const concurrent = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (concurrent?.result) {
          const cached = concurrent.result;
          return res.status(cached.status).json(cached.body);
        }
        return res.status(409).json({
          error: { code: 'DUPLICATE_OPERATION', message: 'Another request with this idempotency key is already in progress' }
        });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }

  let captured = false;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    captured = true;
    res.locals.idempotencyBody = body;
    return originalJson(body);
  };

  const originalStatus = res.status.bind(res);
  res.status = (code) => {
    res.locals.idempotencyStatus = code;
    return originalStatus(code);
  };

  res.on('finish', () => {
    (async () => {
      const storedStatus = res.locals.idempotencyStatus ?? res.statusCode;
      const storedBody = res.locals.idempotencyBody;
      if (captured && storedStatus >= 200 && storedStatus < 400) {
        try {
          await prisma.idempotencyRecord.update({
            where: { key },
            data: { result: { status: storedStatus, body: storedBody } }
          });
        } catch (error) {
          logger.error({ msg: 'failed to store idempotency result', key, err: error.message });
        }
      } else {
        // 4xx/5xx or no body was sent — release the claim so a corrected retry
        // can run rather than forever replaying a failed result.
        try {
          await prisma.idempotencyRecord.deleteMany({ where: { key } });
        } catch (_) {
          /* already gone */
        }
      }
    })();
  });

  next();
};