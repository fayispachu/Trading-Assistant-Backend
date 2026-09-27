function closedCandles(candles) {
  return (candles || [])
    .filter((candle) => candle.isClosed !== false)
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
}

export function getCandleDirection(candle, prevCandle) {
  if (!candle) return 'NEUTRAL';
  const open = candle.open !== undefined ? Number(candle.open) : (prevCandle ? Number(prevCandle.close) : Number(candle.close));
  const close = Number(candle.close);
  if (close < open) return 'SELL';
  if (close > open) return 'BUY';
  return 'NEUTRAL';
}

export function findSwingPivots(candles, strength = 2, options = {}) {
  const bars = closedCandles(candles);
  const lookaround = Math.max(1, Number(strength) || 2);
  const pivots = [];

  for (let index = lookaround; index < bars.length - lookaround; index += 1) {
    const candle = bars[index];
    const neighbors = [
      ...bars.slice(index - lookaround, index),
      ...bars.slice(index + 1, index + lookaround + 1),
    ];

    const isHigh = neighbors.every((item) => candle.high >= item.high);
    const isLow = neighbors.every((item) => candle.low <= item.low);

    if (isHigh) {
      // 2 continuous sell candles needed to consider a swing high
      const c1 = bars[index + 1];
      const c2 = bars[index + 2];
      const d1 = c1 ? getCandleDirection(c1, candle) : 'NEUTRAL';
      const d2 = c2 ? getCandleDirection(c2, c1) : 'NEUTRAL';
      const has2ContinuousSell =
        (d1 === 'SELL' || d1 === 'NEUTRAL') &&
        (d2 === 'SELL' || d2 === 'NEUTRAL') &&
        (d1 === 'SELL' || d2 === 'SELL');

      if (has2ContinuousSell || options.requireContinuousCandles === false || bars.length < 15) {
        pivots.push({
          type: 'HIGH',
          index,
          price: candle.high,
          candle,
          hasContinuousConfirmation: Boolean(has2ContinuousSell),
        });
      }
    }

    if (isLow) {
      // 2 continuous buy candles needed to consider a swing low
      const c1 = bars[index + 1];
      const c2 = bars[index + 2];
      const d1 = c1 ? getCandleDirection(c1, candle) : 'NEUTRAL';
      const d2 = c2 ? getCandleDirection(c2, c1) : 'NEUTRAL';
      const has2ContinuousBuy =
        (d1 === 'BUY' || d1 === 'NEUTRAL') &&
        (d2 === 'BUY' || d2 === 'NEUTRAL') &&
        (d1 === 'BUY' || d2 === 'BUY');

      if (has2ContinuousBuy || options.requireContinuousCandles === false || bars.length < 15) {
        pivots.push({
          type: 'LOW',
          index,
          price: candle.low,
          candle,
          hasContinuousConfirmation: Boolean(has2ContinuousBuy),
        });
      }
    }
  }

  // Graceful fallback if strict filtering on smaller/synthetic datasets yielded too few pivots
  if (pivots.length < 3 && options.requireContinuousCandles !== true) {
    return findSwingPivots(candles, strength, { requireContinuousCandles: false });
  }

  return pivots.sort((left, right) => left.index - right.index || left.type.localeCompare(right.type));
}

export function calculateTimeframeDirection(candles, strength = 2) {
  const bars = closedCandles(candles);
  if (bars.length < 5) {
    return {
      direction: 'NEUTRAL',
      bias: 'NEUTRAL',
      structure: 'RANGE',
      summary: 'Insufficient candles',
      recentHigh: null,
      recentLow: null,
      previousHigh: null,
      previousLow: null,
    };
  }

  let pivots = findSwingPivots(bars, strength);
  if (pivots.length < 4 && strength > 1) {
    pivots = findSwingPivots(bars, 1);
  }

  const highs = pivots.filter((pivot) => pivot.type === 'HIGH').slice(-2);
  const lows = pivots.filter((pivot) => pivot.type === 'LOW').slice(-2);

  if (highs.length < 2 || lows.length < 2) {
    const recentHigh = highs.at(-1) || { price: Math.max(...bars.slice(-20).map((b) => b.high)) };
    const recentLow = lows.at(-1) || { price: Math.min(...bars.slice(-20).map((b) => b.low)) };
    const lastClose = bars.at(-1)?.close || 0;
    const isAboveMid = lastClose > (recentHigh.price + recentLow.price) / 2;

    return {
      direction: isAboveMid ? 'BULLISH' : 'BEARISH',
      bias: isAboveMid ? 'BULLISH' : 'BEARISH',
      structure: 'RANGE',
      summary: `${isAboveMid ? 'Bullish lean' : 'Bearish lean'} (H: $${recentHigh.price}, L: $${recentLow.price})`,
      recentHigh,
      recentLow,
      previousHigh: null,
      previousLow: null,
    };
  }

  const [prevHigh, recentHigh] = highs;
  const [prevLow, recentLow] = lows;

  const higherHighs = recentHigh.price > prevHigh.price;
  const higherLows = recentLow.price > prevLow.price;
  const lowerHighs = recentHigh.price < prevHigh.price;
  const lowerLows = recentLow.price < prevLow.price;

  if (higherHighs && higherLows) {
    return {
      direction: 'BULLISH',
      bias: 'BULLISH',
      structure: 'HH_HL',
      summary: `BULLISH (HH: $${recentHigh.price}, HL: $${recentLow.price})`,
      recentHigh,
      recentLow,
      previousHigh: prevHigh,
      previousLow: prevLow,
    };
  }

  if (lowerHighs && lowerLows) {
    return {
      direction: 'BEARISH',
      bias: 'BEARISH',
      structure: 'LH_LL',
      summary: `BEARISH (LH: $${recentHigh.price}, LL: $${recentLow.price})`,
      recentHigh,
      recentLow,
      previousHigh: prevHigh,
      previousLow: prevLow,
    };
  }

  // Mixed structure (e.g. Higher High with Lower Low or inside structure)
  const bias = higherHighs ? 'BULLISH' : lowerLows ? 'BEARISH' : 'NEUTRAL';
  return {
    direction: bias,
    bias,
    structure: 'RANGE',
    summary: `CONSOLIDATING (${bias}) (H: $${recentHigh.price}, L: $${recentLow.price})`,
    recentHigh,
    recentLow,
    previousHigh: prevHigh,
    previousLow: prevLow,
  };
}

export function calculateStructureBias(candles, strength = 2) {
  const dir = calculateTimeframeDirection(candles, strength);
  return dir.direction;
}

export function analyzeChochSetup(candles, direction = 'BOTH', options = {}) {
  const bars = closedCandles(candles);
  const pivotStrength = Math.max(1, Number(options.pivotStrength) || 2);
  const confirmationCandles = Math.max(2, Number(options.confirmationCandles) || 2);
  let pivots = findSwingPivots(bars, pivotStrength);
  if (pivots.length < 3 && pivotStrength > 1) {
    pivots = findSwingPivots(bars, 1);
  }

  const activeAfter = Number(options.activeAfter) || 0;
  let previousHigh = null;
  let previousLow = null;
  let latestHigherHigh = null;
  let latestLowerLow = null;
  let sellStructure = null;
  let buyStructure = null;

  for (let i = 0; i < pivots.length; i += 1) {
    const pivot = pivots[i];
    if (pivot.type === 'HIGH') {
      if (previousHigh && pivot.price > previousHigh.price) {
        latestHigherHigh = pivot;
        const lowInBetween = pivots
          .slice(0, i)
          .filter((p) => p.type === 'LOW' && p.index > previousHigh.index)
          .at(-1) || previousLow;

        if (lowInBetween) {
          sellStructure = {
            direction: 'SELL',
            anchor: latestHigherHigh,
            level: lowInBetween,
            isPreceding: true,
          };
        }
      } else if (
        previousHigh &&
        pivot.price < previousHigh.price &&
        latestLowerLow &&
        latestLowerLow.index < pivot.index
      ) {
        buyStructure = {
          direction: 'BUY',
          anchor: latestLowerLow,
          level: pivot,
          isSubsequent: true,
        };
      }
      previousHigh = pivot;
      continue;
    }

    if (pivot.type === 'LOW') {
      if (previousLow && pivot.price < previousLow.price) {
        latestLowerLow = pivot;
        const highInBetween = pivots
          .slice(0, i)
          .filter((p) => p.type === 'HIGH' && p.index > previousLow.index)
          .at(-1) || previousHigh;

        if (highInBetween) {
          buyStructure = {
            direction: 'BUY',
            anchor: latestLowerLow,
            level: highInBetween,
            isPreceding: true,
          };
        }
      } else if (
        previousLow &&
        pivot.price > previousLow.price &&
        latestHigherHigh &&
        latestHigherHigh.index < pivot.index
      ) {
        sellStructure = {
          direction: 'SELL',
          anchor: latestHigherHigh,
          level: pivot,
          isSubsequent: true,
        };
      }
      previousLow = pivot;
    }
  }

  const candidates = [sellStructure, buyStructure].filter(Boolean);
  const requestedDirection = String(direction).toUpperCase();

  function evaluateCandidate(struct) {
    if (!struct) return null;
    const breakIdx = bars.findIndex((candle, index) => {
      if (index <= struct.level.index || Number(candle.closeTime) <= activeAfter) return false;
      return struct.direction === 'SELL'
        ? candle.close < struct.level.price
        : candle.close > struct.level.price;
    });
    return { struct, breakIndex: breakIdx };
  }

  const evaluated = candidates
    .filter((item) => requestedDirection === 'BOTH' || item.direction === requestedDirection)
    .map(evaluateCandidate)
    .sort((a, b) => {
      const aBroken = a.breakIndex >= 0;
      const bBroken = b.breakIndex >= 0;
      if (aBroken !== bBroken) return aBroken ? -1 : 1;
      return b.struct.level.index - a.struct.level.index;
    });

  const best = evaluated[0];
  const structure = best?.struct;
  const breakIndex = best ? best.breakIndex : -1;

  if (!structure) {
    return {
      phase: 'WAITING_FOR_SWINGS',
      direction: requestedDirection,
      pivotStrength,
      confirmationCandles,
      candlesSinceChoch: 0,
      candlesRemaining: confirmationCandles,
      confirmed: false,
      sequenceSteps: [
        { id: 1, name: 'Swing Structure', status: 'PENDING', desc: 'Identify HH → HL or LL → LH swing' },
        { id: 2, name: '15M CHOCH Body Close', status: 'PENDING', desc: 'Candle body must close beyond level (wicks rejected)' },
        { id: 3, name: '15M Candle Confirmation #1', status: 'PENDING', desc: 'First completed 15M candle' },
        { id: 4, name: '15M Candle Confirmation #2', status: 'PENDING', desc: 'Second completed 15M candle' },
        { id: 5, name: 'Entry Considered', status: 'PENDING', desc: 'Execute in setup swing area with defined SL/TP' },
      ],
    };
  }

  // Track any wick-only attempts where wick broke but body failed to close beyond
  let wickBreakRejected = false;
  let wickRejectionDetails = null;

  for (let i = structure.level.index + 1; i < bars.length; i += 1) {
    const candle = bars[i];
    if (Number(candle.closeTime) <= activeAfter) continue;
    if (breakIndex >= 0 && i > breakIndex) break;

    const isWickBreach =
      structure.direction === 'SELL'
        ? candle.low < structure.level.price && candle.close >= structure.level.price
        : candle.high > structure.level.price && candle.close <= structure.level.price;

    if (isWickBreach) {
      wickBreakRejected = true;
      wickRejectionDetails = {
        breachPrice: structure.direction === 'SELL' ? candle.low : candle.high,
        closePrice: candle.close,
        swingLevel: structure.level.price,
        time: candle.closeTime,
        message: `Wick breached ${structure.level.price} (wick: ${structure.direction === 'SELL' ? candle.low : candle.high}) but body closed at ${candle.close}. Wick break rejected — awaiting 15M body close.`,
      };
      break;
    }
  }

  const swingAnchorPrice = structure.anchor.price;
  const swingLevelPrice = structure.level.price;
  const swingAreaTop = Math.max(swingAnchorPrice, swingLevelPrice);
  const swingAreaBottom = Math.min(swingAnchorPrice, swingLevelPrice);
  const swingRange = Math.abs(swingAnchorPrice - swingLevelPrice);

  const setupArea = {
    top: swingAreaTop,
    bottom: swingAreaBottom,
    range: swingRange,
    swingType: structure.direction === 'SELL' ? 'HH_TO_HL' : 'LL_TO_LH',
  };

  const invalidationLevel = structure.direction === 'SELL' ? swingAreaTop : swingAreaBottom;
  const riskDistance = swingRange;

  const targets = {
    target1R: structure.direction === 'SELL' ? swingLevelPrice - riskDistance : swingLevelPrice + riskDistance,
    target2R: structure.direction === 'SELL' ? swingLevelPrice - 2 * riskDistance : swingLevelPrice + 2 * riskDistance,
    target3R: structure.direction === 'SELL' ? swingLevelPrice - 3 * riskDistance : swingLevelPrice + 3 * riskDistance,
    stopLoss: invalidationLevel,
    riskRewardRatio: '1:2',
  };

  if (breakIndex < 0) {
    return {
      phase: 'WAITING_FOR_CHOCH',
      direction: structure.direction,
      pivotStrength,
      confirmationCandles,
      swingAnchor: swingAnchorPrice,
      swingLevel: swingLevelPrice,
      swingAnchorTime: structure.anchor.candle.openTime,
      swingLevelTime: structure.level.candle.openTime,
      setupArea,
      targets,
      candlesSinceChoch: 0,
      candlesRemaining: confirmationCandles,
      confirmed: false,
      wickBreakRejected,
      wickRejectionDetails,
      sequenceSteps: [
        {
          id: 1,
          name: 'Swing Structure',
          status: 'TRIGGERED',
          desc: `${structure.direction === 'SELL' ? 'HH' : 'LL'} ($${swingAnchorPrice}) → ${structure.direction === 'SELL' ? 'HL' : 'LH'} ($${swingLevelPrice})`,
        },
        {
          id: 2,
          name: '15M CHOCH Body Close',
          status: wickBreakRejected ? 'WICK_REJECTED' : 'PENDING',
          desc: wickBreakRejected
            ? wickRejectionDetails.message
            : `Awaiting 15M body close ${structure.direction === 'SELL' ? 'below HL ($' + swingLevelPrice + ')' : 'above LH ($' + swingLevelPrice + ')'}`,
        },
        { id: 3, name: `15M Candle Confirmation #1 (${structure.direction === 'SELL' ? 'Continuous Sell' : 'Continuous Buy'})`, status: 'PENDING', desc: `First completed 15M continuous ${structure.direction === 'SELL' ? 'sell' : 'buy'} candle` },
        { id: 4, name: `15M Candle Confirmation #2 (${structure.direction === 'SELL' ? 'Continuous Sell' : 'Continuous Buy'})`, status: 'PENDING', desc: `Second completed 15M continuous ${structure.direction === 'SELL' ? 'sell' : 'buy'} candle` },
        { id: 5, name: 'Entry Considered', status: 'PENDING', desc: 'Setup execution in swing area' },
      ],
    };
  }

  // CHOCH body close found
  const chochCandle = bars[breakIndex];
  const postChochCandles = bars.slice(breakIndex + 1);
  const candlesSinceChoch = postChochCandles.length;
  const reqDir = structure.direction; // 'SELL' or 'BUY'

  // Invalidation: if a candle body closed back beyond swing level
  const invalidated = postChochCandles.some((c) =>
    reqDir === 'SELL' ? c.close > structure.level.price : c.close < structure.level.price
  );

  // Search for the 2 continuous directional candles post-CHOCH that hold structure
  let confirmedPair = null;
  for (let i = 0; i < postChochCandles.length - 1; i += 1) {
    const c1 = postChochCandles[i];
    const c2 = postChochCandles[i + 1];
    const prevC = i === 0 ? chochCandle : postChochCandles[i - 1];
    const dir1 = getCandleDirection(c1, prevC);
    const dir2 = getCandleDirection(c2, c1);

    const c1Held = reqDir === 'SELL' ? c1.close <= structure.level.price : c1.close >= structure.level.price;
    const c2Held = reqDir === 'SELL' ? c2.close <= structure.level.price : c2.close >= structure.level.price;

    const isC1Continuous = c1Held && (dir1 === reqDir || (dir1 === 'NEUTRAL' && c1Held));
    const isC2Continuous = c2Held && (dir2 === reqDir || (dir2 === 'NEUTRAL' && c2Held));

    if (isC1Continuous && isC2Continuous) {
      confirmedPair = {
        index1: i,
        index2: i + 1,
        c1,
        c2,
        dir1,
        dir2,
      };
      break;
    }
  }

  let candle1 = null;
  let candle2 = null;

  if (confirmedPair) {
    const open1 = confirmedPair.c1.open !== undefined ? confirmedPair.c1.open : (postChochCandles[confirmedPair.index1 - 1]?.close || chochCandle.close);
    const open2 = confirmedPair.c2.open !== undefined ? confirmedPair.c2.open : confirmedPair.c1.close;
    candle1 = {
      open: open1,
      high: confirmedPair.c1.high,
      low: confirmedPair.c1.low,
      close: confirmedPair.c1.close,
      closeTime: confirmedPair.c1.closeTime,
      held: true,
      isDirectional: true,
      candleType: confirmedPair.dir1,
    };
    candle2 = {
      open: open2,
      high: confirmedPair.c2.high,
      low: confirmedPair.c2.low,
      close: confirmedPair.c2.close,
      closeTime: confirmedPair.c2.closeTime,
      held: true,
      isDirectional: true,
      candleType: confirmedPair.dir2,
    };
  } else {
    if (postChochCandles.length >= 1) {
      const c1 = postChochCandles[0];
      const dir1 = getCandleDirection(c1, chochCandle);
      const held1 = reqDir === 'SELL' ? c1.close <= structure.level.price : c1.close >= structure.level.price;
      const isDir1 = dir1 === reqDir || (dir1 === 'NEUTRAL' && held1);
      const open1 = c1.open !== undefined ? c1.open : chochCandle.close;

      candle1 = {
        open: open1,
        high: c1.high,
        low: c1.low,
        close: c1.close,
        closeTime: c1.closeTime,
        held: held1,
        isDirectional: isDir1,
        candleType: dir1,
      };
    }

    if (postChochCandles.length >= 2) {
      const c2 = postChochCandles[1];
      const dir2 = getCandleDirection(c2, postChochCandles[0]);
      const held2 = reqDir === 'SELL' ? c2.close <= structure.level.price : c2.close >= structure.level.price;
      const isDir2 = dir2 === reqDir || (dir2 === 'NEUTRAL' && held2);
      const open2 = c2.open !== undefined ? c2.open : postChochCandles[0].close;

      candle2 = {
        open: open2,
        high: c2.high,
        low: c2.low,
        close: c2.close,
        closeTime: c2.closeTime,
        held: held2,
        isDirectional: isDir2,
        candleType: dir2,
      };
    }
  }

  const confirmed = Boolean(confirmedPair && !invalidated);
  const phase = invalidated
    ? 'INVALIDATED'
    : confirmed
    ? 'CONFIRMED'
    : 'WAITING_FOR_CONFIRMATION';

  const continuousLabel = reqDir === 'SELL' ? 'Continuous Sell Candle' : 'Continuous Buy Candle';

  const sequenceSteps = [
    {
      id: 1,
      name: 'Swing Structure',
      status: 'TRIGGERED',
      desc: `${structure.direction === 'SELL' ? 'HH' : 'LL'} ($${swingAnchorPrice}) → ${structure.direction === 'SELL' ? 'HL' : 'LH'} ($${swingLevelPrice})`,
    },
    {
      id: 2,
      name: '15M CHOCH Body Close',
      status: 'TRIGGERED',
      desc: `15M body closed at $${chochCandle.close} beyond ${structure.direction === 'SELL' ? 'HL' : 'LH'} ($${swingLevelPrice})`,
    },
    {
      id: 3,
      name: `15M Confirmation Candle #1 (${continuousLabel})`,
      status: candle1 ? (candle1.held && candle1.isDirectional ? 'TRIGGERED' : 'FAILED') : 'PENDING',
      desc: candle1
        ? candle1.held && candle1.isDirectional
          ? `Candle 1 confirmed (${candle1.candleType} candle: open $${candle1.open} → close $${candle1.close}, held structure)`
          : !candle1.held
          ? `Candle 1 closed back inside setup structure ($${candle1.close})`
          : `Candle 1 is a ${candle1.candleType} candle ($${candle1.close}). Strategy requires continuous ${reqDir} candle.`
        : `Waiting for first 15M continuous ${reqDir.toLowerCase()} candle to complete post-CHOCH`,
    },
    {
      id: 4,
      name: `15M Confirmation Candle #2 (${continuousLabel})`,
      status: candle2 ? (candle2.held && candle2.isDirectional ? 'TRIGGERED' : 'FAILED') : 'PENDING',
      desc: candle2
        ? candle2.held && candle2.isDirectional
          ? `Candle 2 confirmed (${candle2.candleType} candle: open $${candle2.open} → close $${candle2.close}, 2 continuous ${reqDir} candles achieved)`
          : !candle2.held
          ? `Candle 2 closed back inside setup structure ($${candle2.close})`
          : `Candle 2 is a ${candle2.candleType} candle ($${candle2.close}). Strategy requires 2 continuous ${reqDir} candles.`
        : `Waiting for second 15M continuous ${reqDir.toLowerCase()} candle to complete`,
    },
    {
      id: 5,
      name: 'Entry Considered',
      status: confirmed ? 'TRIGGERED' : 'PENDING',
      desc: confirmed
        ? `2 continuous ${reqDir.toLowerCase()} candles confirmed. Target: $${targets.target2R}, Invalidation: $${targets.stopLoss}`
        : 'Awaiting 2 continuous completed candles confirmation',
    },
  ];

  return {
    phase,
    direction: structure.direction,
    pivotStrength,
    confirmationCandles,
    swingAnchor: swingAnchorPrice,
    swingLevel: swingLevelPrice,
    swingAnchorTime: structure.anchor.candle.openTime,
    swingLevelTime: structure.level.candle.openTime,
    chochTime: chochCandle.closeTime,
    chochPrice: chochCandle.close,
    setupArea,
    targets,
    candle1,
    candle2,
    invalidated,
    candlesSinceChoch,
    candlesRemaining: Math.max(0, confirmationCandles - candlesSinceChoch),
    confirmed,
    sequenceSteps,
  };
}