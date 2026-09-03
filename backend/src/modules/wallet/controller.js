import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { 
  getWalletBalance, 
  getWalletTransactions, 
  requestWithdrawal 
} from './service.js';
import { PaystackGateway } from '../payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../payment/FlutterwaveGateway.js';
import prisma from '../../utils/db.js';

export const walletRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();

walletRouter.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const balance = await getWalletBalance(userId);
    if (!balance) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    res.json({ balance });
  } catch (error) {
    next(error);
  }
});

walletRouter.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    
    const data = await getWalletTransactions(userId, page, limit);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

walletRouter.get('/tier-limits', requireAuth, async (req, res, next) => {
  try {
    const { tier } = req.user;
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 'singleton' }
    });
    
    if (!settings) {
      return res.status(500).json({ error: 'Platform settings not configured' });
    }

    let minP, maxP, calloutMaxP;
    switch (tier) {
      case 'MASTER':
        minP = settings.masterStakeMinP;
        maxP = settings.masterStakeMaxP;
        calloutMaxP = settings.masterCalloutMaxP;
        break;
      case 'PRO':
        minP = settings.proStakeMinP;
        maxP = settings.proStakeMaxP;
        calloutMaxP = settings.proCalloutMaxP;
        break;
      case 'AMATEUR':
      default:
        minP = settings.amateurStakeMinP;
        maxP = settings.amateurStakeMaxP;
        calloutMaxP = settings.amateurCalloutMaxP;
        break;
    }

    res.json({
      tier,
      stakeMin: minP.toString(),
      stakeMax: maxP.toString(),
      calloutMax: calloutMaxP.toString()
    });
  } catch (error) {
    next(error);
  }
});

walletRouter.post('/deposit-intent', requireAuth, async (req, res, next) => {
  try {
    const { id: userId, email } = req.user; // requireAuth populates id and email from DB
    const { amountMinorUnits, gateway } = req.body;
    
    if (!amountMinorUnits || isNaN(amountMinorUnits) || amountMinorUnits <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    let gatewayImpl;
    if (gateway === 'paystack') {
      gatewayImpl = paystackGateway;
    } else if (gateway === 'flutterwave') {
      gatewayImpl = flutterwaveGateway;
    } else {
      return res.status(400).json({ error: 'Invalid gateway specified' });
    }

    const { authorizationUrl, reference } = await gatewayImpl.initiatePayment(
      amountMinorUnits,
      userId,
      email || 'user@example.com' // Fallback if email is missing from token payload
    );

    res.json({ authorizationUrl, reference });
  } catch (error) {
    if (error.name === 'PaymentGatewayError') {
      // Specifically catch the Gateway Error and surface a clear message to the client
      return res.status(503).json({ error: error.message });
    }
    next(error);
  }
});

walletRouter.post('/withdrawal-request', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { amountMinorUnits } = req.body;
    
    if (!amountMinorUnits || isNaN(amountMinorUnits) || amountMinorUnits <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    const request = await requestWithdrawal(userId, amountMinorUnits);
    
    res.status(201).json({
      withdrawalRequest: {
        ...request,
        amountMinorUnits: request.amountMinorUnits.toString()
      }
    });
  } catch (error) {
    if (error.name === 'InsufficientFundsError') {
      return res.status(402).json({ error: error.message });
    }
    next(error);
  }
});
