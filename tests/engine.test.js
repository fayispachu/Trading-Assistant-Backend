import { describe, it, expect } from 'vitest';
import {
  buildJournalTradePlan,
  evaluateConditionMatch,
  evaluateJournalTrade,
  getNewChochMilestones,
  isNewOpposingChoch,
  StrategyEngine,
} from '../engine.js';
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

describe('CHOCH notification milestones', () => {
  it('creates one event for a new CHOCH and each valid confirmation candle', () => {
    const progress = {
      direction: 'SELL',
      chochTime: 1000,
      chochPrice: 9.5,
      swingLevel: 10,
      candle1: {
        closeTime: 2000,
        close: 9,
        held: true,
        isDirectional: true,
      },
    };

    expect(getNewChochMilestones({}, progress).map(({ type, stage }) => [type, stage])).toEqual([
      ['CHOCH_DETECTED', 'CHOCH'],
      ['CONFIRMATION_STEP', 'CANDLE_1'],
    ]);
    expect(getNewChochMilestones(progress, progress)).toEqual([]);
    expect(getNewChochMilestones({}, {
      ...progress,
      candle1: { ...progress.candle1, held: false },
    })).toHaveLength(1);
  });

  it('records an opposite CHOCH only after the monitored direction has been established', () => {
    const setup = { direction: 'BUY', strategyStartedAt: new Date(1000) };
    expect(isNewOpposingChoch(setup, {}, { direction: 'SELL', chochTime: 2000 })).toBe(true);
    expect(isNewOpposingChoch(setup, {}, { direction: 'SELL', chochTime: 1000 })).toBe(false);
    expect(isNewOpposingChoch(
      { direction: 'BOTH', strategyStartedAt: new Date(1000) },
      {},
      { direction: 'SELL', chochTime: 2000 }
    )).toBe(false);
    expect(isNewOpposingChoch(
      setup,
      { direction: 'SELL', chochTime: 1500 },
      { direction: 'BUY', chochTime: 2000 }
    )).toBe(true);
  });
});

describe('automated journal trade levels and outcomes', () => {
  it('builds a 1:3 short target from the setup swing stop', () => {
    const plan = buildJournalTradePlan(
      {
        name: 'XRP 15M CHOCH',
        direction: 'BOTH',
        primaryTimeframe: '15M',
        strategyProgress: {
          direction: 'SELL',
          candle2: { close: 100 },
          targets: { stopLoss: 110 },
        },
      },
      100
    );

    expect(plan).toMatchObject({
      tradeEntryPrice: 100,
      tradeStopLoss: 110,
      tradeTakeProfit: 70,
      tradeRiskReward: '1:3',
      journalOutcome: 'OPEN',
      tradeEntryStatus: 'READY',
    });
  });

  it('uses the setup entry and swing stop, and rejects a live price more than 0.25R away', () => {
    const setup = {
      direction: 'BUY',
      strategyProgress: {
        direction: 'BUY',
        candle2: { close: 100 },
        targets: { stopLoss: 90 },
      },
    };

    expect(buildJournalTradePlan(setup, 102.5)).toMatchObject({
      tradeEntryPrice: 102.5,
      tradeStopLoss: 90,
      tradeEntryStatus: 'READY',
    });

    expect(buildJournalTradePlan(setup, 102.51)).toMatchObject({
      tradeEntryPrice: undefined,
      tradeStopLoss: 90,
      tradeTakeProfit: undefined,
      tradeEntryStatus: 'SKIPPED_PRICE_MOVED',
    });
  });

  it('does not create a trade entry when the setup has no usable swing levels', () => {
    expect(buildJournalTradePlan({
      direction: 'BUY',
      strategyProgress: { direction: 'BUY', targets: { stopLoss: 90 } },
    }, 100)).toMatchObject({
      tradeEntryPrice: undefined,
      tradeEntryStatus: 'SKIPPED_INVALID_SETUP',
    });
  });

  it('settles long and short trades at their target or swing stop', () => {
    const long = { direction: 'BUY', tradeEntryPrice: 100, tradeStopLoss: 90, tradeTakeProfit: 130 };
    const short = { direction: 'SELL', tradeEntryPrice: 100, tradeStopLoss: 110, tradeTakeProfit: 70 };

    expect(evaluateJournalTrade(long, { price: 130 })).toMatchObject({
      outcome: 'WIN',
      resultR: 3,
      exitPrice: 130,
    });
    expect(evaluateJournalTrade(long, { price: 90 })).toMatchObject({
      outcome: 'LOSS',
      resultR: -1,
      exitPrice: 90,
    });
    expect(evaluateJournalTrade(short, { price: 70 })).toMatchObject({
      outcome: 'WIN',
      resultR: 3,
      exitPrice: 70,
    });
    expect(evaluateJournalTrade(short, { price: 110 })).toMatchObject({
      outcome: 'LOSS',
      resultR: -1,
      exitPrice: 110,
    });
  });

  it('records a stop loss conservatively when one candle spans both levels', () => {
    expect(
      evaluateJournalTrade(
        { direction: 'BUY', tradeEntryPrice: 100, tradeStopLoss: 90, tradeTakeProfit: 130 },
        { price: 110, low: 89, high: 131 }
      )
    ).toMatchObject({ outcome: 'LOSS', resultR: -1, exitPrice: 90 });
  });

  it('only closes a live trade when price crosses a level after its last observation', () => {
    const long = {
      direction: 'BUY',
      tradeEntryPrice: 100,
      tradeStopLoss: 90,
      tradeTakeProfit: 130,
      journalLastPrice: 135,
    };

    expect(evaluateJournalTrade(long, { price: 136 })).toBeNull();
    expect(
      evaluateJournalTrade({ ...long, journalLastPrice: 129 }, { price: 130 })
    ).toMatchObject({ outcome: 'WIN', resultR: 3, exitPrice: 130 });

    const short = {
      direction: 'SELL',
      tradeEntryPrice: 100,
      tradeStopLoss: 110,
      tradeTakeProfit: 70,
      journalLastPrice: 65,
    };
    expect(evaluateJournalTrade(short, { price: 64 })).toBeNull();
    expect(
      evaluateJournalTrade({ ...short, journalLastPrice: 71 }, { price: 70 })
    ).toMatchObject({ outcome: 'WIN', resultR: 3, exitPrice: 70 });
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

  it('carries a prior directional CHOCH into confirmations completed after monitoring starts', () => {
    const result = analyzeChochSetup(makeCandles(sellValues), 'SELL', {
    pivotStrength: 1,
    activeAfter: 10000000,
    });

    expect(result.phase).toBe('CONFIRMED');
    expect(result.direction).toBe('SELL');
    expect(result.chochTime).toBe(9900000);
    expect(result.candle2.closeTime).toBeGreaterThan(10000000);
  });

  it('uses a fresh CHOCH after an earlier break was invalidated', () => {
    const values = [
    ...sellValues.slice(0, 10),
    [17, 7, 7.5],
    [14, 12, 13],
    [13, 6.8, 7.0],
    [7.0, 6.2, 6.5],
    [6.5, 5.8, 6.0],
    ];
    const result = analyzeChochSetup(makeCandles(values), 'SELL', { pivotStrength: 1 });

    expect(result.phase).toBe('CONFIRMED');
    expect(result.chochTime).toBe(13 * 900000);
    expect(result.direction).toBe('SELL');
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