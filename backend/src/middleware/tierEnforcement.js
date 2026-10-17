import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

// Format minor-unit (kobo) amounts as human-readable naira, e.g. 200000n -> "₦2,000".
export const formatMinorUnitsAsNaira = (minorUnits) => {
  const naira = minorUnits / 100n;
  return `₦${naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
};

/**
 * Validates a user's stake against their tier's continuous bounds.
 *
 * Stakes are a min→max range per tier (not fixed presets): every tier shares a
 * ₦500 floor and the ceiling rises with tier. Matchmaking and call-outs both use
 * a range; a call-out validates against the separate call-out ceiling, which lets
 * a tier be disabled (0) or diverge from the matchmaking max without touching the
 * matchmaking path.
 *
 * @param {boolean} isCallout - If true, validates against the call-out ceiling.
 */
export const requireValidStake = (isCallout = false) => {
  return async (req, res, next) => {
    try {
      const { stakeMinorUnits } = req.body;
      const { id: userId } = req.user;

      if (stakeMinorUnits === undefined) {
        return res.status(400).json({ error: 'stakeMinorUnits is required' });
      }

      let stake;
      try {
        stake = BigInt(stakeMinorUnits);
      } catch {
        return res.status(400).json({ error: 'Invalid stakeMinorUnits format' });
      }
      if (stake < 0n) {
        return res.status(400).json({ error: 'Stake must be positive' });
      }

      // 1. Fetch user to get their tier
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { tier: true }
      });

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      const tier = user.tier; // AMATEUR, MASTER, PRO

      // 2. Fetch platform settings for the tier boundaries
      const settings = await prisma.platformSettings.findUniqueOrThrow({
        where: { id: 'singleton' }
      });

      const minP = settings[`${tier.toLowerCase()}StakeMinP`];
      const maxP = isCallout
        ? settings[`${tier.toLowerCase()}CalloutMaxP`]
        : settings[`${tier.toLowerCase()}StakeMaxP`];

      if (isCallout && maxP === 0n) {
        return res.status(403).json({ error: `${tier} tier is not eligible for call-outs` });
      }

      if (stake < minP || stake > maxP) {
        const label = isCallout ? 'Call-out stake' : 'Stake';
        return res.status(400).json({
          error: `${label} out of bounds. Must be between ${formatMinorUnitsAsNaira(minP)} and ${formatMinorUnitsAsNaira(maxP)} for ${tier} tier.`
        });
      }

      // Attach the validated tier to req.user so downstream handlers don't have to re-fetch
      req.user.tier = tier;
      next();
    } catch (err) {
      logger.error({ err, userId: req.user?.id }, 'Error in tierEnforcement middleware');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };
};
