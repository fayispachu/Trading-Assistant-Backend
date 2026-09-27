import { describe, it, expect } from 'vitest';
import { evaluateConditionMatch, StrategyEngine } from '../engine.js';
import { analyzeChochSetup, calculateTimeframeDirection, findSwingPivots } from '../services/structure.js';
import { normalizeSymbol, timeframeToInterval } from '../services/market.js';

describe('condition mappings', () => {
  it('matches a previous high break', () => {
    expect(
      evaluateConditionMatch(
        { type: 'PREVIOUS_HIGH_BREAK', parameters: {} },
        { type: 'HIGH_BROKEN', symbol: 'XRPUSD.P', direction: 'BULLISH', price: 1.2 }
      )
    ).toBe(true);
  });

  it('matches a bullish choch only when the direction matches', () => {
    expect(
      evaluateConditionMatch(
        { type: 'CHOCH', parameters: { direction: 'BULLISH' } },
        { type: 'CHOCH_DETECTED', symbol: 'XRPUSD.P', direction: 'BULLISH', price: 1.2 }
      )
    ).toBe(true);

    expect(
      evaluateConditionMatch(
        { type: 'CHOCH', parameters: { direction: 'BULLISH' } },
        { type: 'CHOCH_DETECTED', symbol: 'XRPUSD.P', direction: 'BEARISH', price: 1.2 }
      )
    ).toBe(false);
  });

  it('matches a candle confirmation count when threshold is reached', () => {
    expect(
      evaluateConditionMatch(
        { type: 'CANDLE_CONFIRMATION', parameters: { count: 2 } },
        { type: 'CANDLE_CONFIRMED', count: 2, direction: 'BULLISH', price: 1.2 }
      )
    ).toBe(true);
  });

  it('does not match unrelated events', () => {
    expect(
      evaluateConditionMatch(
        { type: 'RETEST', parameters: {} },
        { type: 'LOW_BROKEN', symbol: 'XRPUSD.P', direction: 'BEARISH', price: 1.2 }
      )
    ).toBe(false);
  });

  it('matches the complete CHOCH strategy simulation event', () => {
    expect(
      evaluateConditionMatch(
        { type: 'CHOCH_2C_CONFIRMATION', parameters: { confirmationCandles: 2 } },
        { type: 'STRATEGY_CONFIRMED' }
      )
    ).toBe(true);
  });
});

describe('candle break detection', () => {
  it('compares a candle close against the previous candle, not its intrabar high', async () => {
    const engine = new StrategyEngine(null);
    const firedEvents = [];
    engine.fire = async (event) => firedEvents.push(event);
    engine.processChochSetups = async () => {};
    engine.marketState.set('BTCUSDT', {
      previousHigh: 105,
      previousLow: 95,
      highBreakLocked: false,
      lowBreakLocked: false,
      retestAnchor: null,
      retestPending: false,
    });

    await engine.onTick({ symbol: 'BTCUSDT', price: 110 });
    await engine.onCandle({
      symbol: 'BTCUSDT',
      open: 102,
      high: 110,
      low: 101,
      close: 108,
      closeTime: 1,
    });

    expect(firedEvents.map((event) => event.type)).toContain('CHOCH_DETECTED');
  });

  it('waits for price to move away from a breakout level before confirming a retest', async () => {
    const engine = new StrategyEngine(null);
    const firedEvents = [];
    engine.fire = async (event) => firedEvents.push(event);
    engine.marketState.set('BTCUSDT', {
      previousHigh: 105,
      previousLow: 95,
      highBreakLocked: false,
      lowBreakLocked: false,
      retestAnchor: null,
      retestPending: false,
    });

    await engine.onTick({ symbol: 'BTCUSDT', price: 106 });
    expect(firedEvents.map((event) => event.type)).not.toContain('RETEST_DETECTED');

    await engine.onTick({ symbol: 'BTCUSDT', price: 107 });
    expect(firedEvents.map((event) => event.type)).not.toContain('RETEST_DETECTED');

    await engine.onTick({ symbol: 'BTCUSDT', price: 105.5 });
    expect(firedEvents.filter((event) => event.type === 'RETEST_DETECTED')).toHaveLength(1);
  });
});

describe('15M CHOCH strategy', () => {
  const sellValues = [
    [10, 9, 9.5], [20, 10, 18], [15, 5, 8], [18, 9, 15], [17, 7, 10],
    [22, 10, 18], [19, 8, 16], [20, 13, 17], [18, 12, 14], [17, 13, 15],
    [17, 7, 7.5], [7.5, 6.8, 7.0], [7.0, 6.2, 6.5],
  ];

  const makeCandles = (values) =>
    values.map(([high, low, close], index) => ({
      openTime: index * 900000,
      closeTime: (index + 1) * 900000,
      high,
      low,
      close,
      isClosed: true,
    }));

  it('requires a body close below the higher low and two continuous completed sell candles', () => {
    const wickOnly = sellValues.map(([high, low, close], index) =>
      index >= 10 ? [high, low, 13] : [high, low, close]
    );
    expect(analyzeChochSetup(makeCandles(wickOnly), 'SELL', { pivotStrength: 1 }).phase)
      .toBe('WAITING_FOR_CHOCH');

    const oneCandleAfterBreak = analyzeChochSetup(makeCandles(sellValues.slice(0, 12)), 'SELL', {
      pivotStrength: 1,
    });
    expect(oneCandleAfterBreak.phase).toBe('WAITING_FOR_CONFIRMATION');
    expect(oneCandleAfterBreak.candlesSinceChoch).toBe(1);

    const confirmed = analyzeChochSetup(makeCandles(sellValues), 'SELL', { pivotStrength: 1 });
    expect(confirmed.phase).toBe('CONFIRMED');
    expect(confirmed.swingLevel).toBe(12);
    expect(confirmed.candlesSinceChoch).toBe(2);

    const breakBeforeMonitoring = analyzeChochSetup(makeCandles(sellValues), 'SELL', {
      pivotStrength: 1,
      activeAfter: 12000000,
    });
    expect(breakBeforeMonitoring.phase).toBe('WAITING_FOR_CHOCH');
  });

  it('rejects confirmation if post-CHOCH candle is a buy/bullish candle instead of continuous sell', () => {
    // Index 11 is a buy candle (close: 9.0 > open: 7.5)
    const sellWithBuyCandle = sellValues.map(([high, low, close], index) =>
      index === 11 ? [9.5, 7.2, 9.0] : [high, low, close]
    );
    const result = analyzeChochSetup(makeCandles(sellWithBuyCandle), 'SELL', { pivotStrength: 1 });
    expect(result.confirmed).toBe(false);
    expect(result.phase).toBe('WAITING_FOR_CONFIRMATION');
    expect(result.candle1?.isDirectional).toBe(false);
  });

  it('applies the inverse lower-low/lower-high rule for buys', () => {
    const buyValues = sellValues.map(([high, low, close]) => [30 - low, 30 - high, 30 - close]);
    const result = analyzeChochSetup(makeCandles(buyValues), 'BUY', { pivotStrength: 1 });

    expect(result.phase).toBe('CONFIRMED');
    expect(result.direction).toBe('BUY');
  });
});

describe('Delta Exchange India symbols', () => {
  it('normalizes the chart perpetual symbol without changing its venue', () => {
    expect(normalizeSymbol('DELTAIN:XRPUSD.P')).toBe('XRPUSD.P');
    expect(normalizeSymbol('XRPUSDT')).toBe('XRPUSD.P');
    expect(timeframeToInterval('15M')).toBe('15m');
    expect(timeframeToInterval('4H')).toBe('4h');
  });
});

describe('Higher timeframe direction and wick rejection', () => {
  const makeCandles = (values) =>
    values.map(([high, low, close], index) => ({
      openTime: index * 3600000,
      closeTime: (index + 1) * 3600000,
      high,
      low,
      close,
      isClosed: true,
    }));

  it('calculates higher timeframe 1H/4H structure directions accurately', () => {
    // Uptrend with clear HH and HL peaks and troughs
    const uptrendValues = [
      [10, 8, 9],
      [16, 11, 15], // High 1 (16)
      [12, 9, 10],  // Low 1 (9)
      [20, 13, 19], // High 2 (20 > 16: HH)
      [15, 12, 14], // Low 2 (12 > 9: HL)
      [24, 16, 23], // High 3 (24 > 20: HH)
      [18, 14, 17], // Low 3 (14 > 12: HL)
      [26, 19, 25],
    ];
    const bullishDir = calculateTimeframeDirection(makeCandles(uptrendValues), 1);
    expect(bullishDir.direction).toBe('BULLISH');
    expect(bullishDir.structure).toBe('HH_HL');

    // Downtrend with clear LH and LL peaks and troughs
    const downtrendValues = [
      [30, 25, 27],
      [22, 16, 18], // Low 1 (16)
      [25, 19, 23], // High 1 (25)
      [18, 12, 14], // Low 2 (12 < 16: LL)
      [21, 15, 19], // High 2 (21 < 25: LH)
      [15, 9, 11],  // Low 3 (9 < 12: LL)
      [17, 11, 15], // High 3 (17 < 21: LH)
      [12, 6, 8],
    ];
    const bearishDir = calculateTimeframeDirection(makeCandles(downtrendValues), 1);
    expect(bearishDir.direction).toBe('BEARISH');
    expect(bearishDir.structure).toBe('LH_LL');
  });

  it('rejects wick-only breaks and flags wickBreakRejected awaiting body close', () => {
    const sellValues = [
      [10, 9, 9.5], [20, 10, 18], [15, 5, 8], [18, 9, 15], [17, 7, 10],
      [22, 10, 18], [19, 8, 16], [20, 13, 17], [18, 12, 14], [17, 13, 15],
      // Index 10: Low dipped to 7 (breaking 12 with wick), but close was 13 (above 12)
      [17, 7, 13],
    ];
    const candles = makeCandles(sellValues);
    const result = analyzeChochSetup(candles, 'SELL', { pivotStrength: 1 });
    expect(result.phase).toBe('WAITING_FOR_CHOCH');
    expect(result.wickBreakRejected).toBe(true);
    expect(result.wickRejectionDetails?.breachPrice).toBe(7);
    expect(result.wickRejectionDetails?.closePrice).toBe(13);
  });

  it('tracks candle 1 and candle 2 completion in the sequence steps', () => {
    const sellValues = [
      [10, 9, 9.5], [20, 10, 18], [15, 5, 8], [18, 9, 15], [17, 7, 10],
      [22, 10, 18], [19, 8, 16], [20, 13, 17], [18, 12, 14], [17, 13, 15],
      [17, 7, 7.5], [7.5, 6.8, 7.0], [7.0, 6.2, 6.5],
    ];
    const candles = makeCandles(sellValues);
    const result = analyzeChochSetup(candles, 'SELL', { pivotStrength: 1 });

    expect(result.confirmed).toBe(true);
    expect(result.phase).toBe('CONFIRMED');
    expect(result.candle1).not.toBeNull();
    expect(result.candle2).not.toBeNull();
    expect(result.sequenceSteps).toHaveLength(5);
    expect(result.sequenceSteps[0].status).toBe('TRIGGERED');
    expect(result.sequenceSteps[1].status).toBe('TRIGGERED');
    expect(result.sequenceSteps[2].status).toBe('TRIGGERED');
    expect(result.sequenceSteps[3].status).toBe('TRIGGERED');
    expect(result.sequenceSteps[4].status).toBe('TRIGGERED');
  });

  it('verifies that 2 continuous buy/sell candles are required to consider a swing', () => {
    // 15 candles: peak at index 5
    // If index 6 and 7 are continuous sell candles: swing high is qualified
    const candlesWithContinuousSell = [
      { open: 10, high: 12, low: 9, close: 11 },
      { open: 11, high: 14, low: 10, close: 13 },
      { open: 13, high: 16, low: 12, close: 15 },
      { open: 15, high: 18, low: 14, close: 17 },
      { open: 17, high: 20, low: 16, close: 19 },
      { open: 19, high: 25, low: 18, close: 24 }, // Peak high: 25
      { open: 24, high: 24, low: 20, close: 21 }, // Sell candle 1: close 21 < open 24
      { open: 21, high: 21, low: 17, close: 18 }, // Sell candle 2: close 18 < open 21
      { open: 18, high: 19, low: 16, close: 17 },
      { open: 17, high: 18, low: 15, close: 16 },
      { open: 16, high: 17, low: 14, close: 15 },
      { open: 15, high: 16, low: 13, close: 14 },
      { open: 14, high: 15, low: 12, close: 13 },
      { open: 13, high: 14, low: 11, close: 12 },
      { open: 12, high: 13, low: 10, close: 11 },
    ].map((c, i) => ({ ...c, openTime: i * 900000, closeTime: (i + 1) * 900000, isClosed: true }));

    const pivotsWithSell = findSwingPivots(candlesWithContinuousSell, 2, { requireContinuousCandles: true });
    const highPivots = pivotsWithSell.filter((p) => p.type === 'HIGH');
    expect(highPivots.length).toBeGreaterThanOrEqual(1);
    expect(highPivots[0].index).toBe(5);

    // If candle 7 was a green/buy candle instead of sell candle, the peak at index 5 is NOT considered a confirmed swing high
    const candlesWithBrokenSell = candlesWithContinuousSell.map((c, i) =>
      i === 7 ? { ...c, open: 20, high: 24, low: 19, close: 23 } : c // Green candle
    );
    const pivotsBroken = findSwingPivots(candlesWithBrokenSell, 2, { requireContinuousCandles: true });
    expect(pivotsBroken.filter((p) => p.type === 'HIGH' && p.index === 5)).toHaveLength(0);
  });
});