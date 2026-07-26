import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireValidStake } from '../../middleware/tierEnforcement.js';
import { 
  createCallout, 
  getOpenCallouts, 
  acceptCallout 
} from './service.js';

export const calloutRouter = express.Router();

// Fetch open callouts that the user is tier-eligible to accept
calloutRouter.get('/open', requireAuth, async (req, res, next) => {
  try {
    const { userId } = req.user;
    const callouts = await getOpenCallouts(userId);
    res.status(200).json({ callouts });
  } catch (err) {
    next(err);
  }
});

// Create a new callout
calloutRouter.post('/', requireAuth, requireValidStake(true), async (req, res, next) => {
  try {
    const { userId, tier } = req.user;
    const { stakeMinorUnits } = req.body;
    
    const callout = await createCallout(userId, tier, stakeMinorUnits);
    res.status(201).json({ callout });
  } catch (err) {
    next(err);
  }
});

// Accept an existing callout
calloutRouter.post('/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const { userId } = req.user;
    const calloutId = req.params.id;
    
    const match = await acceptCallout(userId, calloutId);
    if (!match) {
      return res.status(409).json({ error: 'Callout is no longer available or has expired' });
    }
    
    res.status(200).json({ match });
  } catch (err) {
    if (err.name === 'InsufficientFundsError') {
      return res.status(402).json({ error: err.message });
    }
    next(err);
  }
});
