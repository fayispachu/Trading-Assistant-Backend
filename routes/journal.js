import { Router } from 'express';
import { AgentEvent } from '../models/index.js';
import { getJournalStartAt } from '../models/JournalState.js';
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
    entryStatus: event.tradeEntryStatus ?? null,
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

  router.get('/', async (req, res) => {
    try {
      const journalStartAt = await getJournalStartAt();
      if (!engine.journalStartAt) {
        engine.journalStartAt = journalStartAt;
      }
      const events = await AgentEvent.find({
        userId: req.user.id,
        type: 'STRATEGY_CONFIRMED',
        createdAt: { $gte: journalStartAt },
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
