import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

// The allowed matchmaking presets per tier (in minor units / kobo)
// These align with the Option A product decision for discrete stake buckets.
export const STAKE_PRESETS = {
  AMATEUR: [50000n, 100000n, 500000n],
  MASTER: [1000000n, 1500000n, 3000000n],
  PRO: [3000000n, 5000000n, 6000000n]
};

/**
 * Validates a user's stake against their tier limits.
 * @param {boolean} isCallout - If true, validates against call-out ceiling instead of strict presets.
 */
export const requireValidStake = (isCallout = false) => {
  return async (req, res, next) => {
    try {
      const { stakeMinorUnits } = req.body;
      const { id: userId } = req.user;

      if (stakeMinorUnits === undefined) {
        return res.status(400).json({ error: 'stakeMinorUnits is required' });
      }

      const stake = BigInt(stakeMinorUnits);
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

      if (isCallout) {
        // Validate against the call-out ceiling for the tier
        const minP = settings[`${tier.toLowerCase()}StakeMinP`];
        const calloutMaxP = settings[`${tier.toLowerCase()}CalloutMaxP`];

        if (calloutMaxP === 0n) {
          return res.status(403).json({ error: `${tier} tier is not eligible for call-outs` });
        }

        if (stake < minP || stake > calloutMaxP) {
          return res.status(400).json({ 
            error: `Call-out stake out of bounds. Must be between ${minP} and ${calloutMaxP} for ${tier} tier.` 
          });
        }
      } else {
        // Option A: Preset Stakes (Matchmaking)
        // Must be one of the explicitly allowed presets for their tier
        const allowedPresets = STAKE_PRESETS[tier];
        if (!allowedPresets.includes(stake)) {
          return res.status(400).json({ 
            error: `Invalid matchmaking stake for ${tier} tier. Must be one of: ${allowedPresets.join(', ')}` 
          });
        }

        // Just to be safe, ensure the preset is within the DB bounds
        const minP = settings[`${tier.toLowerCase()}StakeMinP`];
        const maxP = settings[`${tier.toLowerCase()}StakeMaxP`];
        if (stake < minP || stake > maxP) {
          logger.error({ tier, stake }, 'Misconfigured preset exceeds platform settings bounds');
          return res.status(500).json({ error: 'Internal configuration error' });
        }
      }

      // Attach the validated tier to req.user so downstream handlers don't have to re-fetch
      req.user.tier = tier;
      next();
    } catch (err) {
      if (err instanceof SyntaxError || err.name === 'SyntaxError') {
        // BigInt parsing error
        return res.status(400).json({ error: 'Invalid stakeMinorUnits format' });
      }
      logger.error({ err, userId: req.user?.id }, 'Error in tierEnforcement middleware');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };
};
