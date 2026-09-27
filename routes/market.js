import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { normalizeSymbol } from '../services/market.js';
import { calculateStructureBias, calculateTimeframeDirection } from '../services/structure.js';

export function createMarketRouter(provider) {
  const router = Router();

  router.get('/overview', async (req, res) => {
    try {
      const overview = await provider.getTopMarketOverview();
      return res.json(overview);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch market overview.' });
    }
  });

  router.get('/:symbol', async (req, res) => {
    try {
      const cleanSymbol = normalizeSymbol(req.params.symbol);
      let snapshot = provider.getSnapshot(cleanSymbol);

      if (!snapshot.price || Date.now() - snapshot.updatedAt > 12000) {
        await provider.refresh(cleanSymbol);
        snapshot = provider.getSnapshot(cleanSymbol);
      }

      const oneHourDir = calculateTimeframeDirection(snapshot.candlesByTimeframe?.['1H']);
      const fourHourDir = calculateTimeframeDirection(snapshot.candlesByTimeframe?.['4H']);

      return res.json({
        ...snapshot,
        tradingViewChartUrl:
          cleanSymbol === 'XRPUSD.P'
            ? 'https://www.tradingview.com/chart/x3ifAQ1f/?symbol=DELTAIN%3AXRPUSD.P'
            : `https://www.tradingview.com/chart/?symbol=DELTAIN:${cleanSymbol}`,
        timeframeBias: {
          '1H': oneHourDir.direction,
          '4H': fourHourDir.direction,
          '1H_DETAILS': oneHourDir,
          '4H_DETAILS': fourHourDir,
        },
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Market data unavailable.' });
    }
  });

  return router;
}
