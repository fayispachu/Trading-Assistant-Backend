import { Router } from 'express';
import { z } from 'zod';
import { Setup } from '../models/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { normalizeSymbol } from '../services/market.js';

export function createSetupsRouter(engine, provider) {
  const router = Router();
  router.use(authMiddleware);

  const setupSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    symbol: z.string().min(2, 'Symbol is required'),
    assetClass: z.string().default('Crypto'),
    direction: z.enum(['BUY', 'SELL', 'BOTH']).default('BUY'),
    primaryTimeframe: z.string().default('15M'),
    confirmationTimeframe: z.string().default('15M'),
    explanation: z.string().max(4000).default(''),
    conditionMode: z.enum(['SEQUENTIAL', 'INDEPENDENT']).default('SEQUENTIAL'),
    conditions: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          name: z.string(),
          timeframe: z.string().optional(),
          parameters: z.record(z.any()).default({}),
          order: z.number().default(1),
          required: z.boolean().default(true),
        })
      )
      .min(1, 'At least one confirmation condition is required'),
    entryRule: z.string().optional().default(''),
    stopLossRule: z.string().optional().default(''),
    takeProfitRule: z.string().optional().default(''),
    riskReward: z.string().optional().default(''),
    notifications: z.boolean().default(true),
    sound: z.boolean().default(true),
    telegram: z.boolean().default(false),
  });

  router.get('/', async (req, res) => {
    try {
      let setups = await Setup.find({ userId: req.user.id }).sort({ updatedAt: -1 });

      if (setups.length === 0) {
        try {
          const defaultSetup = await Setup.create({
            userId: req.user.id,
            name: 'XRPUSD.P 15M CHOCH + 2-Candle Confirmation',
            symbol: 'XRPUSD.P',
            assetClass: 'Crypto',
            direction: 'BOTH',
            primaryTimeframe: '15M',
            confirmationTimeframe: '15M',
            conditionMode: 'SEQUENTIAL',
            explanation:
              '### 15M CHOCH + 2-Candle Confirmation Setup\nTimeframe: 15-minute\nSell: HH → HL → Body Close Below HL → 2-Candle Confirmation → Sell\nBuy: LL → LH → Body Close Above LH → 2-Candle Confirmation → Buy\nRule: Body-close break required (wicks do not count), followed by minimum 2 completed 15M candles. Higher timeframe directions: 1H and 4H.',
            entryRule: 'Entry in broken swing area (HH → HL / LL → LH) after 2-candle confirmation',
            stopLossRule: 'Structural swing invalidation beyond HH (Sell) or LL (Buy)',
            takeProfitRule: '2R target from entry / structural liquidity target',
            riskReward: '1:2',
            notifications: true,
            sound: true,
            conditions: [
              {
                id: `cond_default_${Date.now()}`,
                type: 'CHOCH_2C_CONFIRMATION',
                name: '15M CHOCH + 2 completed candles',
                timeframe: '15M',
                parameters: { pivotStrength: 2, confirmationCandles: 2 },
                order: 1,
                required: true,
                status: 'PENDING',
              },
            ],
            status: 'MONITORING',
          });

          await engine.start(defaultSetup);
          const fresh = await Setup.findById(defaultSetup._id);
          setups = fresh ? [fresh] : [defaultSetup];
        } catch (seedErr) {
          console.warn('Auto-seed default setup note:', seedErr.message);
        }
      }

      return res.json(setups);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch setups.' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues[0]?.message || 'Invalid setup data.';
        return res.status(400).json({ error: errorMsg });
      }

      const cleanSymbol = normalizeSymbol(parsed.data.symbol);

      const setup = await Setup.create({
        ...parsed.data,
        symbol: cleanSymbol,
        userId: req.user.id,
        conditions: parsed.data.conditions.map((condition) => ({
          ...condition,
          status: 'PENDING',
        })),
        status: 'MONITORING',
      });

      try {
        await engine.start(setup);
      } catch (error) {
        await Setup.deleteOne({ _id: setup._id });
        return res.status(503).json({ error: error.message || 'Live market data is unavailable for this symbol.' });
      }

      return res.status(201).json(setup);
    } catch (error) {
      console.error('Setup creation error:', error);
      return res.status(500).json({ error: 'Failed to create setup.' });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const setup = await Setup.findOne({ _id: req.params.id, userId: req.user.id });
      if (!setup) return res.status(404).json({ error: 'Setup not found.' });
      return res.json(setup);
    } catch {
      return res.status(500).json({ error: 'Failed to fetch setup.' });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const setup = await Setup.findOne({ _id: req.params.id, userId: req.user.id });
      if (!setup) return res.status(404).json({ error: 'Setup not found.' });

      Object.assign(setup, req.body);
      await setup.save();
      return res.json(setup);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to update setup.' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const setup = await Setup.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
      if (!setup) return res.status(404).json({ error: 'Setup not found.' });

      // If no other setups use this symbol, unsubscribe
      const otherSetups = await Setup.countDocuments({ symbol: setup.symbol });
      if (otherSetups === 0) {
        provider.unsubscribe(setup.symbol);
      }

      return res.sendStatus(204);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to delete setup.' });
    }
  });

  router.post('/:id/pause', async (req, res) => {
    try {
      const setup = await Setup.findOne({ _id: req.params.id, userId: req.user.id });
      if (!setup) return res.status(404).json({ error: 'Setup not found.' });

      setup.status = 'PAUSED';
      await setup.save();
      return res.json(setup);
    } catch {
      return res.status(500).json({ error: 'Failed to pause setup.' });
    }
  });

  router.post('/:id/resume', async (req, res) => {
    try {
      const setup = await Setup.findOne({ _id: req.params.id, userId: req.user.id });
      if (!setup) return res.status(404).json({ error: 'Setup not found.' });

      setup.status = 'MONITORING';
      await setup.save();
      await engine.start(setup);
      return res.json(setup);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to resume setup.' });
    }
  });

  router.post('/:id/reset', async (req, res) => {
    try {
      const setup = await Setup.findOne({ _id: req.params.id, userId: req.user.id });
      if (!setup) return res.status(404).json({ error: 'Setup not found.' });

      setup.status = 'MONITORING';
      setup.conditions.forEach((condition) => {
        condition.status = 'PENDING';
        condition.triggeredAt = undefined;
        condition.triggeredPrice = undefined;
        condition.message = '';
      });

      await setup.save();
      await engine.start(setup);
      return res.json(setup);
    } catch {
      return res.status(500).json({ error: 'Failed to reset setup.' });
    }
  });

  router.post('/:id/simulate', async (req, res) => {
    try {
      const setup = await Setup.findOne({ _id: req.params.id, userId: req.user.id });
      if (!setup) return res.status(404).json({ error: 'Setup not found.' });

      const result = await engine.simulateNextCondition(setup._id);
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Simulation failed.' });
    }
  });

  return router;
}
