/**
 * Free-play route: a solo game against the server bot.
 *
 * The request carries no money and asks for no opponent: the server creates
 * the match, seats the bot in the other side and returns the match id so the
 * client can open the board. The live projection is seeded here, but the turn
 * clock only opens when the player actually joins the room (see the join
 * handler), so nobody is charged for the time spent navigating to the board.
 */
import { Router } from 'express';
import logger from '../../utils/logger.js';
import prisma from '../../utils/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { initializeFreePlayGame } from '../../sockets/freePlayRuntime.js';
import {
  createFreePlayMatch,
  freePlaySnapshot,
  InvalidFreePlayRequestError
} from './freePlayService.js';

export const freePlayRouter = Router();

freePlayRouter.post(
  '/free-play',
  requireAuth,
  requireIdempotencyKey({ scope: 'match' }),
  async (req, res, next) => {
    try {
      const { id: userId } = req.user;
      const { side, botLevel, timeControlSeconds } = req.body ?? {};

      const created = await createFreePlayMatch({
        userId,
        side,
        botLevel,
        timeControlSeconds
      });

      try {
        await initializeFreePlayGame({
          matchId: created.match.id,
          humanId: userId,
          botId: created.botId,
          side: created.humanSide,
          tier: created.match.tier,
          timeControlSeconds: created.timeControlSeconds,
          botLevel: created.level
        });
      } catch (err) {
        // The match row exists but the live projection could not be seeded.
        // The row is finished as abandoned so it never sits in the live set.
        logger.error({ err, matchId: created.match.id }, 'Free play: projection seed failed');
        await prisma.match.updateMany({
          where: { id: created.match.id, status: 'IN_PLAY' },
          data: { status: 'CANCELLED', endReason: 'free_play_start_failed', endedAt: new Date() }
        }).catch(() => {});
        throw err;
      }

      res.status(201).json({
        data: freePlaySnapshot({
          match: created.match,
          humanSide: created.humanSide,
          level: created.level,
          timeControlSeconds: created.timeControlSeconds
        })
      });
    } catch (err) {
      if (err instanceof InvalidFreePlayRequestError) {
        return res.status(400).json({
          error: { code: 'INVALID_FREE_PLAY_REQUEST', message: err.message }
        });
      }
      next(err);
    }
  }
);
