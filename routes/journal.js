import { Router } from 'express';
import { z } from 'zod';
import { AgentEvent } from '../models/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { isNasdaqSymbol } from '../services/market.js';

function toJournalEntry(event) {
  return {
    id: `${event.setupId}-${event._id}`,
    setupId: String(event.setupId),
    name: event.setupName || `${event.symbol} setup`,
    symbol: event.symbol,
    direction: event.direction || 'BOTH',
    timeframe: event.timeframe || '15M',
    confirmedAt: event.createdAt,
    entryPrice: event.tradeEntryPrice ?? null,
    stopLoss: event.tradeStopLoss ?? null,
    takeProfit: event.tradeTakeProfit ?? null,
    riskReward: event.tradeRiskReward || '1:3',
    outcome: event.journalOutcome || 'OPEN',
    resultR: event.journalResultR ?? null,
    exitPrice: event.tradeExitPrice ?? null,
    closedAt: event.journalClosedAt ?? null,
    resultSource: event.journalResultSource ?? null,
  };
}

export function createJournalRouter(engine) {
  const router = Router();
  router.use(authMiddleware);

  const legacyEntrySchema = z.object({
    id: z.string().max(200).optional(),
    setupId: z.string().max(100).optional(),
    name: z.string().max(200).optional(),
    symbol: z.string().max(50).optional(),
    direction: z.string().max(20).optional(),
    timeframe: z.string().max(20).optional(),
    confirmedAt: z.string().max(100).optional(),
    entryPrice: z.number().finite().nullable().optional(),
    stopLoss: z.number().finite().nullable().optional(),
  });

  router.post('/backfill', async (req, res) => {
    const parsed = z.object({
      entries: z.array(legacyEntrySchema).max(1000).default([]),
    }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid legacy journal data.' });
    }

    try {
      await engine.backfillJournalTrades(req.user.id, parsed.data.entries);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to backfill journal entries:', error);
      return res.status(500).json({ error: 'Failed to backfill journal entries.' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      await engine.backfillJournalTrades(req.user.id);
      const events = await AgentEvent.find({
        userId: req.user.id,
        type: 'STRATEGY_CONFIRMED',
      })
        .sort({ createdAt: -1 })
        .lean();

      return res.json(events.filter((event) => !isNasdaqSymbol(event.symbol)).map(toJournalEntry));
    } catch (error) {
      console.error('Failed to fetch journal entries:', error);
      return res.status(500).json({ error: 'Failed to fetch journal entries.' });
    }
  });

  return router;
}
