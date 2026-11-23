import { describe, it, expect } from 'vitest';
import { isNasdaqSymbol, normalizeSymbol } from '../services/market.js';
import {
  calculateEMA,
  calculatePivots,
  evaluateNqBulletStrategy,
  getIstTime,
} from '../services/nqBullet.js';
import { sendTestEmail } from '../services/email.js';

describe('NQ Bullet Strategy Engine', () => {
  it('identifies NASDAQ symbols properly without forcing USD.P', () => {
    expect(isNasdaqSymbol('IG:NASDAQ')).toBe(true);
    expect(isNasdaqSymbol('IG:NDX')).toBe(true);
    expect(isNasdaqSymbol('CAPITALCOM:US100')).toBe(true);
    expect(isNasdaqSymbol('NAS100')).toBe(true);
    expect(isNasdaqSymbol('NQ1!')).toBe(true);
    expect(isNasdaqSymbol('XRPUSD.P')).toBe(false);

    expect(normalizeSymbol('IG:NASDAQ')).toBe('IG:NASDAQ');
    expect(normalizeSymbol('NASDAQ')).toBe('IG:NASDAQ');
    expect(normalizeSymbol('IG:NDX')).toBe('IG:NDX');
    expect(normalizeSymbol('US100')).toBe('CAPITALCOM:US100');
    expect(normalizeSymbol('XRP')).toBe('XRPUSD.P');
  });

  it('calculates 50 EMA accurately', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 20000 + i * 10);
    const ema = calculateEMA(prices, 50);
    expect(ema.length).toBe(60);
    expect(ema[49]).toBeGreaterThan(20000);
    expect(ema[59]).toBeGreaterThan(ema[58]); // rising slope
  });

  it('calculates 1H Pivot High and Low levels with stop-on-break detection', () => {
    const candles1h = [
      { open: 20400, high: 20420, low: 20380, close: 20410 },
      { open: 20410, high: 20440, low: 20400, close: 20430 },
      { open: 20430, high: 20480, low: 20420, close: 20470 },
      { open: 20470, high: 20550, low: 20460, close: 20520 }, // pivot high
      { open: 20520, high: 20510, low: 20440, close: 20450 },
      { open: 20450, high: 20460, low: 20390, close: 20400 },
      { open: 20400, high: 20410, low: 20330, close: 20360 }, // pivot low
      { open: 20360, high: 20390, low: 20360, close: 20380 },
      { open: 20380, high: 20420, low: 20370, close: 20410 },
      { open: 20410, high: 20450, low: 20400, close: 20440 },
    ];

    const pivots = calculatePivots(candles1h, 3, 3);
    expect(pivots.majorHigh).toBe(20550);
    expect(pivots.majorLow).toBe(20330);
    expect(pivots.highBroken).toBe(false);
  });

  it('evaluates NQ Bullet 5-step sequence with Box, Retest, and 1:2 R:R targets', () => {
    const candles15m = Array.from({ length: 30 }, (_, i) => ({
      open: 20400 + i * 5,
      high: 20420 + i * 5,
      low: 20390 + i * 5,
      close: 20415 + i * 5,
      openTime: Date.now() - (30 - i) * 15 * 60 * 1000,
      closeTime: Date.now() - (29 - i) * 15 * 60 * 1000,
    }));

    const result = evaluateNqBulletStrategy(candles15m, [], {
      boxSession: '1030-1045',
      tradeSession: '1045-1515',
      emaLength: 10,
      rr: 2.0,
    });

    expect(result.strategy).toBe('NQ_BULLET');
    expect(result.sequenceSteps.length).toBe(5);
    expect(result.targets.riskReward).toBe('1:2');
    expect(result.targets.stopLoss).toBeDefined();
    expect(result.targets.takeProfit).toBeDefined();
  });

  it('verifies free email test dispatch function runs successfully', async () => {
    const res = await sendTestEmail({
      to: 'test@example.com',
      userConfig: { provider: 'ethereal' },
    });
    expect(res.success).toBe(true);
    expect(res.recipient).toBe('test@example.com');
  }, 15000);
});
