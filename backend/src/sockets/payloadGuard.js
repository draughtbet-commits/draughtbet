import { z } from 'zod';

export const MIN_SQUARE = 1;
export const MAX_SQUARE = 50;
const MAX_MATCH_ID_LENGTH = 64;
const MAX_PAYLOAD_BYTES = 4096;

const matchId = z.string().min(1).max(MAX_MATCH_ID_LENGTH);
const square = z.number().int().min(MIN_SQUARE).max(MAX_SQUARE);

export const moveAttemptSchema = z.strictObject({
  matchId,
  from: square,
  to: square
});

export const matchIdPayloadSchema = z.strictObject({
  matchId
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

export const validateMatchIdPayload = (payload) => {
  if (payloadTooLarge(payload)) return { ok: false };
  return parse(matchIdPayloadSchema, payload);
};