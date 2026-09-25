import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import prisma from '../../utils/db.js';

export const playersRouter = express.Router();

// Only genuinely public profile fields ever leave this module. Email, phone,
// full legal name, address, credential and KYC/eligibility state are excluded
// by construction. Match listings already expose `fullName` to a matched
// opponent; a directory-search endpoint must not widen that to any caller, so
// search/profile results deliberately omit it.
const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  tier: true,
  playerStats: {
    select: {
      rating: true,
      wins: true,
      losses: true,
      draws: true,
      totalMatches: true
    }
  },
  isBanned: true
};

const asPublicPlayer = (user) => {
  const stats = user.playerStats;
  const wins = stats?.wins ?? 0;
  const losses = stats?.losses ?? 0;
  const draws = stats?.draws ?? 0;
  const total = wins + losses + draws;
  const winRate =
    total > 0 ? Math.round(((stats.wins ?? 0) * 100) / total) : null;
  return {
    id: user.id,
    username: user.username ?? null,
    displayName: user.displayName ?? null,
    avatar: user.avatar ?? null,
    tier: user.tier,
    rating: stats?.rating ?? null,
    wins,
    losses,
    draws,
    totalMatches: stats?.totalMatches ?? 0,
    winRate
  };
};

// GET /api/v1/players/search?username=..&limit=..
// Searches the public directory by username or display name. Requires at
// least two characters so a caller cannot enumerate the whole user table, and
// caps the page at 20 rows. The caller is never listed, and banned accounts
// are invisible.
playersRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const term = req.query.username?.toString().trim() ?? '';
    if (term.length < 2) {
      return res.status(400).json({
        error: 'username must be at least 2 characters'
      });
    }
    if (term.length > 80) {
      return res.status(400).json({
        error: 'username must be 80 characters or fewer'
      });
    }
    const parsedLimit = Number.parseInt(req.query.limit ?? '10', 10);
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 20)
      : 10;

    const users = await prisma.user.findMany({
      where: {
        id: { not: req.user.id },
        isBanned: false,
        OR: [
          { username: { contains: term, mode: 'insensitive' } },
          { displayName: { contains: term, mode: 'insensitive' } }
        ]
      },
      select: PUBLIC_USER_SELECT,
      orderBy: { username: 'asc' },
      take: limit
    });

    res.json({ data: { players: users.map(asPublicPlayer) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/players/:id — one player's public profile + game stats.
// Any authenticated user may look up any public profile; it never exposes
// contact or verification data.
playersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, isBanned: false },
      select: PUBLIC_USER_SELECT
    });
    if (!user) {
      return res.status(404).json({ error: 'Player not found' });
    }
    res.json({ data: { player: asPublicPlayer(user) } });
  } catch (err) {
    next(err);
  }
});