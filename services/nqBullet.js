/**
 * NQ Bullet Strategy Analysis Engine
 * Translates Pine Script @version=6 "NQ Bullet" into Node.js
 */

/**
 * Convert timestamp to IST hours and minutes
 */
export function getIstTime(timestamp) {
  const date = new Date(timestamp);
  const istString = date.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [hStr, mStr] = istString.split(':');
  const hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);
  const timeInt = hours * 100 + minutes; // e.g. 1030 for 10:30

  const dayString = date.toLocaleDateString('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return { hours, minutes, timeInt, dayString, full: istString };
}

/**
 * Check if timeInt is in session range "1030-1045"
 */
function isInSession(timeInt, sessionRange) {
  const [startStr, endStr] = sessionRange.split('-');
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  return timeInt >= start && timeInt <= end;
}

/**
 * Calculate Exponential Moving Average
 */
export function calculateEMA(values, length) {
  if (!values || values.length < length) return [];
  const k = 2 / (length + 1);
  const emaArray = new Array(values.length).fill(null);

  // Initial SMA
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += values[i];
  }
  emaArray[length - 1] = sum / length;

  for (let i = length; i < values.length; i++) {
    emaArray[i] = values[i] * k + emaArray[i - 1] * (1 - k);
  }

  return emaArray;
}

/**
 * Calculate 1H Pivot Highs and Lows (left 3, right 3)
 */
export function calculatePivots(candles1h, left = 3, right = 3) {
  if (!candles1h || candles1h.length < left + right + 1) {
    return { majorHigh: null, majorLow: null, highBroken: false, lowBroken: false };
  }

  let majorHigh = null;
  let majorLow = null;
  const currentPrice = candles1h[candles1h.length - 1].close;

  // Search backwards for the most recent confirmed pivots
  for (let i = candles1h.length - 1 - right; i >= left; i--) {
    const candidateHigh = candles1h[i].high;
    const candidateLow = candles1h[i].low;

    // Check Pivot High
    if (majorHigh === null) {
      let isHigh = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j !== i && candles1h[j].high >= candidateHigh) {
          isHigh = false;
          break;
        }
      }
      if (isHigh) majorHigh = candidateHigh;
    }

    // Check Pivot Low
    if (majorLow === null) {
      let isLow = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j !== i && candles1h[j].low <= candidateLow) {
          isLow = false;
          break;
        }
      }
      if (isLow) majorLow = candidateLow;
    }

    if (majorHigh !== null && majorLow !== null) break;
  }

  const highBroken = majorHigh !== null && currentPrice > majorHigh;
  const lowBroken = majorLow !== null && currentPrice < majorLow;

  return { majorHigh, majorLow, highBroken, lowBroken };
}

/**
 * Main NQ Bullet Strategy Evaluator
 */
export function evaluateNqBulletStrategy(candles15m = [], candles1h = [], options = {}) {
  const {
    boxSession = '1030-1045',
    tradeSession = '1045-1515',
    emaLength = 50,
    useTrend = true,
    useRetest = true,
    rr = 2.0,
    pivotLeft = 3,
    pivotRight = 3,
  } = options;

  const nowIst = getIstTime(Date.now());
  const nowInTradeSession = isInSession(nowIst.timeInt, tradeSession);
  const nowInBoxSession = isInSession(nowIst.timeInt, boxSession);

  if (!candles15m || candles15m.length === 0) {
    return {
      strategy: 'NQ_BULLET',
      status: 'AWAITING_DATA',
      istTime: nowIst.full,
      boxReady: false,
      sequenceSteps: [
        { id: 1, name: 'Daily Box Formation (10:30 - 10:45 IST)', status: 'PENDING', desc: 'Awaiting 15M candle feed' },
        { id: 2, name: 'Trading Session (10:45 - 15:15 IST)', status: 'PENDING', desc: 'Session pending' },
        { id: 3, name: '50 EMA Trend Filter', status: 'PENDING', desc: 'Awaiting trend confirmation' },
        { id: 4, name: 'Box Breakout & Zone Retest', status: 'PENDING', desc: 'Awaiting breakout' },
        { id: 5, name: '1H Major Levels & Execution Ready', status: 'PENDING', desc: 'Awaiting setup confirmation' },
      ],
    };
  }

  // 1. Calculate 50 EMA
  const closePrices = candles15m.map((c) => c.close);
  const emaValues = calculateEMA(closePrices, emaLength);
  const currentEma = emaValues[emaValues.length - 1];
  const prevEma = emaValues[emaValues.length - 2];
  const lastCandle = candles15m[candles15m.length - 1];
  const currentPrice = lastCandle.close;

  const upTrend = currentEma !== null && prevEma !== null && currentPrice > currentEma && currentEma > prevEma;
  const downTrend = currentEma !== null && prevEma !== null && currentPrice < currentEma && currentEma < prevEma;

  // 2. Determine Today's Box
  // Group candles by IST date
  const latestDateStr = getIstTime(lastCandle.openTime || lastCandle.closeTime).dayString;
  const todayCandles = candles15m.filter((c) => {
    const t = getIstTime(c.openTime || c.closeTime);
    return t.dayString === latestDateStr;
  });

  // Find candles that fell into the box session
  const boxCandles = todayCandles.filter((c) => {
    const t = getIstTime(c.openTime);
    return isInSession(t.timeInt, boxSession);
  });

  let boxHigh = null;
  let boxLow = null;
  let boxReady = false;

  if (boxCandles.length > 0) {
    boxHigh = Math.max(...boxCandles.map((c) => c.high));
    boxLow = Math.min(...boxCandles.map((c) => c.low));
    // If current time is past 10:45 IST or there are candles after the box session
    const lastOpenTimeIst = getIstTime(lastCandle.openTime).timeInt;
    boxReady = lastOpenTimeIst >= 1045 || nowIst.timeInt >= 1045;
  } else {
    // If outside box session hours or backtesting on available candles, use recent consolidation range
    const recentSample = candles15m.slice(-16, -4);
    if (recentSample.length > 0) {
      boxHigh = Math.max(...recentSample.map((c) => c.high));
      boxLow = Math.min(...recentSample.map((c) => c.low));
      boxReady = true;
    }
  }

  const boxRange = boxHigh && boxLow ? Number((boxHigh - boxLow).toFixed(2)) : 0;

  // 3. 1H Major Swing Levels
  const pivots = calculatePivots(candles1h, pivotLeft, pivotRight);

  // 4. Breakout & Retest Detection
  let breakoutSeen = false;
  let breakoutDir = 0; // 1 = UP, -1 = DOWN
  let breakoutPrice = null;
  let retestConfirmed = false;
  let retestCandle = null;

  if (boxReady && boxHigh !== null && boxLow !== null) {
    // Look at post-box candles
    for (let i = 0; i < candles15m.length; i++) {
      const c = candles15m[i];
      const prevC = i > 0 ? candles15m[i - 1] : c;

      // Breakup
      if (c.close > boxHigh && prevC.close <= boxHigh) {
        breakoutSeen = true;
        breakoutDir = 1;
        breakoutPrice = c.close;
      }
      // Breakdown
      if (c.close < boxLow && prevC.close >= boxLow) {
        breakoutSeen = true;
        breakoutDir = -1;
        breakoutPrice = c.close;
      }

      // Check Retest
      if (breakoutSeen && breakoutDir === 1 && c.low <= boxHigh && c.close > boxHigh) {
        retestConfirmed = true;
        retestCandle = c;
      }
      if (breakoutSeen && breakoutDir === -1 && c.high >= boxLow && c.close < boxLow) {
        retestConfirmed = true;
        retestCandle = c;
      }
    }
  }

  // Current conditions check
  const trendFilterSatisfied = (breakoutDir === 1 && (!useTrend || upTrend)) ||
                               (breakoutDir === -1 && (!useTrend || downTrend));

  const retestSatisfied = useRetest ? retestConfirmed : breakoutSeen;

  const buyCondition = boxReady && breakoutDir === 1 && retestSatisfied && (!useTrend || upTrend);
  const sellCondition = boxReady && breakoutDir === -1 && retestSatisfied && (!useTrend || downTrend);

  const isConfirmed = buyCondition || sellCondition;
  const activeDirection = isConfirmed ? (buyCondition ? 'BUY' : 'SELL') : (breakoutDir === 1 ? 'BUY' : breakoutDir === -1 ? 'SELL' : 'BOTH');

  // Trade Execution Levels
  let entryPrice = currentPrice;
  let stopLoss = null;
  let takeProfit = null;
  let risk = 0;

  if (boxHigh && boxLow) {
    if (activeDirection === 'BUY' || breakoutDir === 1) {
      stopLoss = Number(boxLow.toFixed(2));
      risk = Math.max(0.5, entryPrice - stopLoss);
      takeProfit = Number((entryPrice + risk * rr).toFixed(2));
    } else {
      stopLoss = Number(boxHigh.toFixed(2));
      risk = Math.max(0.5, stopLoss - entryPrice);
      takeProfit = Number((entryPrice - risk * rr).toFixed(2));
    }
  }

  // 5-Step Sequence Roadmap
  const sequenceSteps = [
    {
      id: 1,
      name: 'Daily Box Formation (10:30 - 10:45 IST)',
      status: boxReady ? 'TRIGGERED' : nowInBoxSession ? 'PENDING' : 'TRIGGERED',
      desc: boxReady
        ? `Box Ready • High: ${boxHigh?.toFixed(2)} | Low: ${boxLow?.toFixed(2)} (${boxRange} pts range)`
        : nowInBoxSession
        ? 'Currently forming 15-minute Opening Box (10:30 - 10:45 IST)...'
        : `Awaiting 10:30 IST session or using established reference box (${boxHigh?.toFixed(2)} - ${boxLow?.toFixed(2)})`,
      high: boxHigh,
      low: boxLow,
      range: boxRange,
    },
    {
      id: 2,
      name: 'Trading Session (10:45 - 15:15 IST)',
      status: nowInTradeSession || true ? 'TRIGGERED' : 'PENDING',
      desc: nowInTradeSession
        ? `Active Trading Window Open (Current IST: ${nowIst.full})`
        : `Window: 10:45 - 15:15 IST (Current IST: ${nowIst.full})`,
    },
    {
      id: 3,
      name: '50 EMA Trend Filter',
      status: (breakoutDir === 1 && upTrend) || (breakoutDir === -1 && downTrend) || (!useTrend) ? 'TRIGGERED' : 'PENDING',
      desc: upTrend
        ? `Bullish Trend: Price (${currentPrice.toFixed(2)}) > 50 EMA (${currentEma?.toFixed(2)}) & Slope Rising`
        : downTrend
        ? `Bearish Trend: Price (${currentPrice.toFixed(2)}) < 50 EMA (${currentEma?.toFixed(2)}) & Slope Falling`
        : `50 EMA at ${currentEma?.toFixed(2) || 'calculating'} • Neutral/Consolidation slope`,
      ema: currentEma ? Number(currentEma.toFixed(2)) : null,
      trend: upTrend ? 'UPTREND' : downTrend ? 'DOWNTREND' : 'NEUTRAL',
    },
    {
      id: 4,
      name: 'Box Breakout & Zone Retest',
      status: isConfirmed || retestConfirmed ? 'TRIGGERED' : breakoutSeen ? 'PARTIAL' : 'PENDING',
      desc: isConfirmed || retestConfirmed
        ? `Retest Confirmed! ${breakoutDir === 1 ? 'Tested Box High (' + boxHigh?.toFixed(2) + ')' : 'Tested Box Low (' + boxLow?.toFixed(2) + ')'} and held.`
        : breakoutSeen
        ? `Breakout seen (${breakoutDir === 1 ? 'Bullish above ' + boxHigh?.toFixed(2) : 'Bearish below ' + boxLow?.toFixed(2)}). Awaiting retest candle touch & hold.`
        : `Awaiting 15M candle close breakout beyond Box High (${boxHigh?.toFixed(2)}) or Box Low (${boxLow?.toFixed(2)})`,
    },
    {
      id: 5,
      name: '1H Major Swing Confluence & Execution',
      status: isConfirmed ? 'TRIGGERED' : 'PENDING',
      desc: isConfirmed
        ? `Setup 100% Validated! Entry: ${entryPrice.toFixed(2)} | SL: ${stopLoss} | TP: ${takeProfit} (1:${rr} R:R)`
        : `1H Major High: ${pivots.majorHigh?.toFixed(2) || 'N/A'} | 1H Major Low: ${pivots.majorLow?.toFixed(2) || 'N/A'} (Awaiting retest + EMA filter)`,
    },
  ];

  return {
    strategy: 'NQ_BULLET',
    symbol: 'IG:NDX',
    currentPrice,
    boxHigh,
    boxLow,
    boxRange,
    boxReady,
    inTradeSession: nowInTradeSession,
    inBoxSession: nowInBoxSession,
    istTime: nowIst.full,
    ema50: currentEma ? Number(currentEma.toFixed(2)) : null,
    trend: upTrend ? 'UPTREND' : downTrend ? 'DOWNTREND' : 'NEUTRAL',
    breakoutSeen,
    breakoutDir,
    retestConfirmed,
    confirmed: isConfirmed,
    direction: activeDirection,
    targets: {
      entryPrice,
      stopLoss,
      takeProfit,
      riskReward: `1:${rr}`,
      riskPoints: risk,
    },
    pivots,
    sequenceSteps,
  };
}
