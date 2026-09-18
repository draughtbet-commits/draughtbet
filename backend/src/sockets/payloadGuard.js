import { z } from 'zod';

export const MIN_SQUARE = 1;
export const MAX_SQUARE = 50;
const MAX_MATCH_ID_LENGTH = 64;
const MAX_PAYLOAD_BYTES = 4096;

const matchId = z.string().min(1).max(MAX_MATCH_ID_LENGTH);
const square = z.number().int().min(MIN_SQUARE).max(MAX_SQUARE);

// Client move idempotency key (V2). Same alphabet/limits as the HTTP
// idempotency keys so a client can use one generator for both.
const clientMoveId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const moveAttemptSchema = z.strictObject({
  matchId,
  from: square,
  to: square
});

// V2 move.submit payload. `path` is the complete landing sequence
// (`[from, ..., to]`) and is the authoritative shape for multi-capture
// intention; `to` is accepted as a shortcut for simple moves. When both are
// present they must agree. `expectedStateVersion` is optional on the wire so a
// client can submit without a known version, but is normally present and is
// what forces a stale client to resync.
export const moveSubmitSchema = z.strictObject({
  matchId,
  clientMoveId,
  expectedStateVersion: z.number().int().min(0).optional(),
  from: square,
  to: square.optional(),
  path: z.array(square).min(2).max(20).optional()
}).superRefine((data, ctx) => {
  const derivedTo = data.to ?? (data.path ? data.path[data.path.length - 1] : undefined);
  if (derivedTo === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'to or path is required', path: ['to'] });
    return;
  }
  if (data.path) {
    if (data.path[0] !== data.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'path must start at from', path: ['path'] });
    }
    if (data.path[data.path.length - 1] !== derivedTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'path must end at to', path: ['path'] });
    }
    if (new Set(data.path).size !== data.path.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'path squares must be unique', path: ['path'] });
    }
  }
});

export const matchIdPayloadSchema = z.strictObject({
  matchId
});

// Clock sync carries the client's own send timestamp only so it can measure
// round-trip time; the server time in the reply is always authoritative.
export const clockSyncSchema = z.strictObject({
  matchId,
  clientSentAt: z.number().int().min(0).optional()
});

export const payloadTooLarge = (payload) => {
  if (payload === null || payload === undefined) return false;
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES;
  } catch {
    return true;
  }
};

const parse = (schema, payload) => {
  const result = schema.safeParse(payload);
  return result.success ? { ok: true, data: result.data } : { ok: false };
};

export const validateMoveAttempt = (payload) => {
  if (payloadTooLarge(payload)) return { ok: false };
  return parse(moveAttemptSchema, payload);
};

export const validateMoveSubmit = (payload) => {
  if (payloadTooLarge(payload)) return { ok: false };
  return parse(moveSubmitSchema, payload);
};

export const validateMatchIdPayload = (payload) => {
  if (payloadTooLarge(payload)) return { ok: false };
  return parse(matchIdPayloadSchema, payload);
};

export const validateClockSync = (payload) => {
  if (payloadTooLarge(payload)) return { ok: false };
  return parse(clockSyncSchema, payload);
};