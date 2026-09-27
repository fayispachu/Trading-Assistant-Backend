import { EventEmitter } from 'node:events';
import { Setup, AgentEvent } from '../models/index.js';
import { normalizeSymbol } from './market.js';
import { analyzeChochSetup, calculateStructureBias, calculateTimeframeDirection } from './structure.js';

export function evaluateConditionMatch(condition, event) {
  const params = condition.parameters || {};

  switch (condition.type) {
    case 'PREVIOUS_HIGH_BREAK':
      return event.type === 'HIGH_BROKEN';
    case 'PREVIOUS_LOW_BREAK':
      return event.type === 'LOW_BROKEN';
    case 'CHOCH':
      return event.type === 'CHOCH_DETECTED' && (!params.direction || params.direction === event.direction);
    case 'BOS':
      return event.type === 'BOS_DETECTED' && (!params.direction || params.direction === event.direction);
    case 'CANDLE_CONFIRMATION':
      return event.type === 'CANDLE_CONFIRMED' && (!params.count || event.count >= Number(params.count));
    case 'RETEST':
      return event.type === 'RETEST_DETECTED';
    case 'BULLISH_CANDLE':
      return event.type === 'CANDLE_CONFIRMED' && event.direction === 'BULLISH';
    case 'BEARISH_CANDLE':
      return event.type === 'CANDLE_CONFIRMED' && event.direction === 'BEARISH';
    case 'ENTRY_CONFIRMATION':
      return event.type === 'ENTRY_CONFIRMED';
    case 'CHOCH_2C_CONFIRMATION':
      return event.type === 'STRATEGY_CONFIRMED';
    default:
      if (condition.type.startsWith('CUSTOM_CONFIRMATION_') && event.type === condition.type) {
        return true;
      }
      return false;
  }
}

export class StrategyEngine {
  constructor(provider) {
    this.provider = provider;
    this.bus = new EventEmitter();
    this.marketState = new Map();
    this.candleState = new Map();
    this.candleHistory = new Map();

    if (provider && typeof provider.onTick === 'function') {
      provider.onTick((tick) => {
        this.onTick(tick).catch((err) => {
          console.warn('StrategyEngine onTick error:', err.message);
        });
      });
    }

    if (provider && typeof provider.onCandle === 'function') {
      provider.onCandle((candle) => {
        this.onCandle(candle).catch((err) => {
          console.warn('StrategyEngine onCandle error:', err.message);
        });
      });
    }

    if (provider && typeof provider.onRefresh === 'function') {
      provider.onRefresh(({ symbol, snapshot }) => {
        this.seedFromSnapshot(symbol, snapshot);
        const frameHistory = this.candleHistory.get(symbol) || new Map();
        const candles = frameHistory.get('15M') || [];
        if (candles.length > 0) {
          this.processChochSetups(symbol, candles, frameHistory).catch((err) => {
            console.warn('StrategyEngine onRefresh error:', err.message);
          });
        }
      });
    }

    if (provider && provider.events) {
      provider.events.on('event', (event) => {
        this.handleExternalEvent(event).catch((err) => {
          console.warn('StrategyEngine externalEvent error:', err.message);
        });
      });
    }
  }

  onUpdate(cb) {
    this.bus.on('update', cb);
  }

  async start(setup) {
    try {
      await this.provider.subscribe(setup.symbol, setup.primaryTimeframe);
      const record = await Setup.findById(setup._id);
      if (!record) return;
      record.symbol = normalizeSymbol(record.symbol);
      this.seedFromSnapshot(record.symbol, this.provider.getSnapshot(record.symbol));

      record.status = 'MONITORING';
      record.strategyStartedAt = new Date();
      record.strategyProgress = null;
      record.conditions.forEach((condition) => {
        condition.status = 'PENDING';
        condition.triggeredAt = undefined;
        condition.triggeredPrice = undefined;
        condition.message = '';
      });

      const strategyCondition = record.conditions.find(
        (condition) => condition.type === 'CHOCH_2C_CONFIRMATION'
      );
      if (strategyCondition) {
        const frameHistory = this.candleHistory.get(record.symbol) || new Map();
        record.strategyProgress = analyzeChochSetup(
          frameHistory.get('15M'),
          record.direction,
          { ...strategyCondition.parameters }
        );
        const oneHourDir = calculateTimeframeDirection(frameHistory.get('1H'));
        const fourHourDir = calculateTimeframeDirection(frameHistory.get('4H'));
        record.strategyProgress.timeframeBias = {
          '1H': oneHourDir,
          '4H': fourHourDir,
        };

        if (record.strategyProgress.confirmed) {
          strategyCondition.status = 'TRIGGERED';
          strategyCondition.triggeredAt = new Date(record.strategyProgress.chochTime || Date.now());
          strategyCondition.triggeredPrice = record.strategyProgress.chochPrice;
          strategyCondition.message = `${record.strategyProgress.direction} CHOCH confirmed: 15M body closed beyond ${record.strategyProgress.direction === 'SELL' ? 'HL' : 'LH'} at $${record.strategyProgress.swingLevel}; ${record.strategyProgress.confirmationCandles} completed 15M candles followed. Setup Area: $${record.strategyProgress.setupArea?.bottom} - $${record.strategyProgress.setupArea?.top}. HTF: 1H ${oneHourDir.direction}, 4H ${fourHourDir.direction}.`;
          record.status = 'CONFIRMED';
        } else if (record.strategyProgress.phase === 'WAITING_FOR_CONFIRMATION') {
          record.status = 'PARTIALLY_CONFIRMED';
        }
      }

      await record.save();

      let eventRecord = null;
      if (record.status === 'CONFIRMED' && strategyCondition) {
        eventRecord = new AgentEvent({
          userId: record.userId,
          setupId: record._id,
          eventId: `STRATEGY_CONFIRMED-${Date.now()}-${record._id}`,
          type: 'STRATEGY_CONFIRMED',
          symbol: record.symbol,
          message: strategyCondition.message,
          price: record.strategyProgress.chochPrice,
          direction: record.strategyProgress.direction,
        });
        await eventRecord.save();
      }

      this.bus.emit('update', {
        type: 'setup-start',
        setupId: record._id.toString(),
        userId: record.userId.toString(),
        setup: record.toObject(),
        event: eventRecord?.toObject(),
      });
    } catch (err) {
      console.warn(`StrategyEngine start error for ${setup.symbol}:`, err.message);
    }
  }

  seedFromSnapshot(symbol, snapshot) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const frames = new Map();
    for (const [timeframe, candles] of Object.entries(snapshot?.candlesByTimeframe || {})) {
      frames.set(
        timeframe,
        candles
          .filter((candle) => candle.isClosed)
          .slice(-500)
          .sort((left, right) => left.openTime - right.openTime)
      );
    }
    this.candleHistory.set(normalizedSymbol, frames);
  }

  async onTick(tick) {
    if (!tick || !tick.symbol) return;

    try {
      const snapshot = this.provider?.getSnapshot?.(tick.symbol);
      const previousClosedCandle = snapshot?.candles?.filter((candle) => candle.isClosed).at(-1);
      const state = this.marketState.get(tick.symbol) || {
        previousHigh: previousClosedCandle?.high ?? tick.price,
        previousLow: previousClosedCandle?.low ?? tick.price,
        lastPrice: tick.price,
        highBreakLocked: false,
        lowBreakLocked: false,
        retestAnchor: null,
        retestPending: false,
        retestDirection: null,
        retestMovedAway: false,
      };

      if (tick.price > state.previousHigh && !state.highBreakLocked) {
        state.highBreakLocked = true;
        state.retestPending = true;
        state.retestAnchor = state.previousHigh;
        state.retestDirection = 'BULLISH';
        state.retestMovedAway = false;
        await this.fire({
          id: `high:${tick.symbol}:${Date.now()}`,
          type: 'HIGH_BROKEN',
          symbol: tick.symbol,
          price: tick.price,
          direction: 'BULLISH',
          message: `Previous high broken for ${tick.symbol} at $${tick.price}`,
        });
      }

      if (tick.price < state.previousLow && !state.lowBreakLocked) {
        state.lowBreakLocked = true;
        state.retestPending = true;
        state.retestAnchor = state.previousLow;
        state.retestDirection = 'BEARISH';
        state.retestMovedAway = false;
        await this.fire({
          id: `low:${tick.symbol}:${Date.now()}`,
          type: 'LOW_BROKEN',
          symbol: tick.symbol,
          price: tick.price,
          direction: 'BEARISH',
          message: `Previous low broken for ${tick.symbol} at $${tick.price}`,
        });
      }

      if (state.retestPending && state.retestAnchor != null) {
        const retestDistance = Math.abs(tick.price - state.retestAnchor);
        const retestTolerance = Math.abs(state.retestAnchor) * 0.015;
        const movedAway =
          state.retestDirection === 'BULLISH'
            ? tick.price > state.retestAnchor + retestTolerance
            : tick.price < state.retestAnchor - retestTolerance;

        if (!state.retestMovedAway && movedAway) {
          state.retestMovedAway = true;
        } else if (state.retestMovedAway && retestDistance <= retestTolerance) {
          state.retestPending = false;
          state.retestMovedAway = false;
          await this.fire({
            id: `retest:${tick.symbol}:${Date.now()}`,
            type: 'RETEST_DETECTED',
            symbol: tick.symbol,
            price: tick.price,
            direction: state.retestDirection,
            message: `Retest confirmed near key zone for ${tick.symbol} at $${tick.price}`,
          });
        }
      }

      state.lastPrice = tick.price;
      this.marketState.set(tick.symbol, state);
    } catch (err) {
      console.warn('onTick processing error:', err.message);
    }
  }

  async onCandle(candle) {
    if (!candle || !candle.symbol) return;

    try {
      const timeframe = candle.timeframe || '15M';
      const frameHistory = this.candleHistory.get(candle.symbol) || new Map();
      const candles = frameHistory.get(timeframe) || [];
      if (candles.at(-1)?.closeTime >= candle.closeTime) return;
      const previousCandle = candles.at(-1);
      candles.push(candle);
      if (candles.length > 500) candles.shift();
      frameHistory.set(timeframe, candles);
      this.candleHistory.set(candle.symbol, frameHistory);

      if (timeframe === '15M') {
        await this.processChochSetups(candle.symbol, candles, frameHistory);
      }

      const candleStateKey = `${candle.symbol}:${timeframe}`;
      const state = this.candleState.get(candleStateKey) || {
        previousHigh: previousCandle?.high ?? candle.open,
        previousLow: previousCandle?.low ?? candle.open,
        confirmationCount: 0,
      };
      const direction = candle.close >= candle.open ? 'BULLISH' : 'BEARISH';

      if (candle.close > candle.open && candle.close >= state.previousHigh * 1.0005) {
        await this.fire({
          id: `choch:${candle.symbol}:${Date.now()}`,
          type: 'CHOCH_DETECTED',
          symbol: candle.symbol,
          timeframe,
          price: candle.close,
          direction: 'BULLISH',
          message: `Bullish CHOCH detected for ${candle.symbol} at $${candle.close}`,
        });
      }

      if (candle.close < candle.open && candle.close <= state.previousLow * 0.9995) {
        await this.fire({
          id: `bos:${candle.symbol}:${Date.now()}`,
          type: 'BOS_DETECTED',
          symbol: candle.symbol,
          timeframe,
          price: candle.close,
          direction: 'BEARISH',
          message: `Bearish BOS detected for ${candle.symbol} at $${candle.close}`,
        });
      }

      state.confirmationCount = (state.confirmationCount || 0) + 1;
      await this.fire({
        id: `candle:${candle.symbol}:${Date.now()}`,
        type: 'CANDLE_CONFIRMED',
        symbol: candle.symbol,
        timeframe,
        price: candle.close,
        direction,
        count: state.confirmationCount,
        message: `Candle confirmation #${state.confirmationCount} (${direction}) for ${candle.symbol}`,
      });

      state.previousHigh = candle.high;
      state.previousLow = candle.low;
      state.highBreakLocked = false;
      state.lowBreakLocked = false;
      state.lastClose = candle.close;
      this.candleState.set(candleStateKey, state);
    } catch (err) {
      console.warn('onCandle processing error:', err.message);
    }
  }

  async processChochSetups(symbol, candles, frameHistory) {
    const setups = await Setup.find({
      symbol,
      status: { $in: ['MONITORING', 'PARTIALLY_CONFIRMED'] },
      'conditions.type': 'CHOCH_2C_CONFIRMATION',
    });
    const oneHourDir = calculateTimeframeDirection(frameHistory.get('1H'));
    const fourHourDir = calculateTimeframeDirection(frameHistory.get('4H'));

    for (const setup of setups) {
      const condition = setup.conditions.find((item) => item.type === 'CHOCH_2C_CONFIRMATION');
      if (!condition || condition.status === 'TRIGGERED') continue;

      const progress = analyzeChochSetup(candles, setup.direction, {
        ...condition.parameters,
        activeAfter: setup.strategyStartedAt?.getTime(),
      });
      progress.timeframeBias = { '1H': oneHourDir, '4H': fourHourDir };
      setup.strategyProgress = progress;

      if (progress.confirmed) {
        condition.status = 'TRIGGERED';
        condition.triggeredAt = new Date();
        condition.triggeredPrice = progress.chochPrice;
        condition.message = `${progress.direction} CHOCH confirmed: body closed beyond ${progress.direction === 'SELL' ? 'HL' : 'LH'} at $${progress.swingLevel}; ${progress.confirmationCandles} completed 15M candles followed. Setup Area: $${progress.setupArea?.bottom} - $${progress.setupArea?.top}. HTF: 1H ${oneHourDir.direction}, 4H ${fourHourDir.direction}.`;
        setup.status = 'CONFIRMED';
        await setup.save();

        const eventRecord = new AgentEvent({
          userId: setup.userId,
          setupId: setup._id,
          eventId: `STRATEGY_CONFIRMED-${progress.chochTime}-${setup._id}`,
          type: 'STRATEGY_CONFIRMED',
          symbol: setup.symbol,
          message: condition.message,
          price: progress.chochPrice,
          direction: progress.direction,
        });
        await eventRecord.save();
        this.bus.emit('update', {
          type: 'setup:update',
          setupId: setup._id.toString(),
          userId: setup.userId.toString(),
          setup: setup.toObject(),
          event: eventRecord.toObject(),
        });
        continue;
      }

      await setup.save();
      this.bus.emit('update', {
        type: 'setup:progress',
        setupId: setup._id.toString(),
        userId: setup.userId.toString(),
        setup: setup.toObject(),
      });
    }
  }

  async handleExternalEvent(event) {
    if (!event || !event.symbol) return;
    try {
      await this.fire({
        ...event,
        id: `${event.type}:${event.symbol}:${Date.now()}`,
        message: event.message || `${event.type} for ${event.symbol}`,
      });
    } catch (err) {
      console.warn('handleExternalEvent error:', err.message);
    }
  }

  async simulateNextCondition(setupId) {
    const setup = await Setup.findById(setupId);
    if (!setup) throw new Error('Setup not found');

    const strategyCondition = setup.conditions.find((c) => c.type === 'CHOCH_2C_CONFIRMATION');
    if (strategyCondition && strategyCondition.status !== 'TRIGGERED') {
      const snapshot = await this.provider.getSnapshot(setup.symbol);
      const currentPrice = Number(snapshot?.price || 1.53);
      const dir = setup.direction === 'BOTH' ? 'SELL' : setup.direction;
      const isSell = dir === 'SELL';
      const swingAnchor = isSell ? Number((currentPrice * 1.012).toFixed(4)) : Number((currentPrice * 0.988).toFixed(4));
      const swingLevel = isSell ? Number((currentPrice * 0.998).toFixed(4)) : Number((currentPrice * 1.002).toFixed(4));

      let progress = setup.strategyProgress || { phase: 'WAITING_FOR_SWINGS' };

      if (progress.phase === 'WAITING_FOR_SWINGS') {
        progress = {
          phase: 'WAITING_FOR_CHOCH',
          direction: dir,
          pivotStrength: 2,
          confirmationCandles: 2,
          swingAnchor,
          swingLevel,
          swingAnchorTime: Date.now() - 3600000,
          swingLevelTime: Date.now() - 1800000,
          setupArea: {
            top: Math.max(swingAnchor, swingLevel),
            bottom: Math.min(swingAnchor, swingLevel),
            range: Math.abs(swingAnchor - swingLevel),
            swingType: isSell ? 'HH_TO_HL' : 'LL_TO_LH',
          },
          targets: {
            stopLoss: isSell ? swingAnchor : swingLevel,
            target1R: isSell ? swingLevel - Math.abs(swingAnchor - swingLevel) : swingLevel + Math.abs(swingAnchor - swingLevel),
            target2R: isSell ? swingLevel - 2 * Math.abs(swingAnchor - swingLevel) : swingLevel + 2 * Math.abs(swingAnchor - swingLevel),
            riskRewardRatio: '1:2',
          },
          candlesSinceChoch: 0,
          candlesRemaining: 2,
          confirmed: false,
          timeframeBias: progress.timeframeBias || {
            '1H': { direction: isSell ? 'BEARISH' : 'BULLISH', summary: `${isSell ? 'BEARISH' : 'BULLISH'} (1H)` },
            '4H': { direction: isSell ? 'BEARISH' : 'BULLISH', summary: `${isSell ? 'BEARISH' : 'BULLISH'} (4H)` },
          },
          sequenceSteps: [
            { id: 1, name: 'Swing Structure', status: 'TRIGGERED', desc: `${isSell ? 'HH' : 'LL'} ($${swingAnchor}) → ${isSell ? 'HL' : 'LH'} ($${swingLevel}) identified` },
            { id: 2, name: '15M CHOCH Body Close', status: 'PENDING', desc: `Waiting for 15M body close beyond $${swingLevel}` },
            { id: 3, name: '15M Candle Confirmation #1', status: 'PENDING', desc: 'First completed 15M candle' },
            { id: 4, name: '15M Candle Confirmation #2', status: 'PENDING', desc: 'Second completed 15M candle' },
            { id: 5, name: 'Entry Considered', status: 'PENDING', desc: 'Setup execution in swing area' },
          ],
        };
        setup.strategyProgress = progress;
        setup.status = 'PARTIALLY_CONFIRMED';
        await setup.save();
        this.bus.emit('update', { type: 'setup:progress', setupId: setup._id.toString(), userId: setup.userId.toString(), setup: setup.toObject() });
        return { setup, message: `Step 1/5 Triggered: ${dir} Swing Structure Established (${isSell ? 'HH' : 'LL'}: $${swingAnchor} → ${isSell ? 'HL' : 'LH'}: $${swingLevel})` };
      } else if (progress.phase === 'WAITING_FOR_CHOCH') {
        const chochPrice = isSell ? Number((swingLevel - 0.0012).toFixed(4)) : Number((swingLevel + 0.0012).toFixed(4));
        progress.phase = 'WAITING_FOR_CONFIRMATION';
        progress.chochPrice = chochPrice;
        progress.chochTime = Date.now();
        progress.candlesSinceChoch = 1;
        progress.candlesRemaining = 1;
        progress.candle1 = { open: swingLevel, high: swingLevel, low: chochPrice, close: chochPrice, closeTime: Date.now(), held: true, isClosed: true };
        if (progress.sequenceSteps && progress.sequenceSteps[1]) {
          progress.sequenceSteps[1].status = 'TRIGGERED';
          progress.sequenceSteps[1].desc = `15M body closed at $${chochPrice} beyond $${swingLevel} (Wicks rejected)`;
        }
        if (progress.sequenceSteps && progress.sequenceSteps[2]) {
          progress.sequenceSteps[2].status = 'TRIGGERED';
          progress.sequenceSteps[2].desc = `Candle 1 closed at $${chochPrice} (Structure maintained)`;
        }
        setup.strategyProgress = progress;
        setup.status = 'PARTIALLY_CONFIRMED';
        await setup.save();
        this.bus.emit('update', { type: 'setup:progress', setupId: setup._id.toString(), userId: setup.userId.toString(), setup: setup.toObject() });
        return { setup, message: `Step 2 & 3 Triggered: 15M CHOCH Body Close at $${chochPrice} & Confirmation Candle #1 closed!` };
      } else {
        // Confirmation candle 2 & entry ready
        const confirmPrice = currentPrice;
        progress.phase = 'CONFIRMED';
        progress.confirmed = true;
        progress.candlesSinceChoch = 2;
        progress.candlesRemaining = 0;
        progress.candle2 = { open: progress.chochPrice, high: progress.chochPrice, low: confirmPrice, close: confirmPrice, closeTime: Date.now(), held: true, isClosed: true };
        if (progress.sequenceSteps && progress.sequenceSteps[3]) {
          progress.sequenceSteps[3].status = 'TRIGGERED';
          progress.sequenceSteps[3].desc = `Candle 2 completed at $${confirmPrice} (Confirmation complete)`;
        }
        if (progress.sequenceSteps && progress.sequenceSteps[4]) {
          progress.sequenceSteps[4].status = 'TRIGGERED';
          progress.sequenceSteps[4].desc = `Entry ready! Swing area: $${Math.min(swingAnchor, swingLevel)} - $${Math.max(swingAnchor, swingLevel)}. Stop Loss: $${progress.targets?.stopLoss}`;
        }

        strategyCondition.status = 'TRIGGERED';
        strategyCondition.triggeredAt = new Date();
        strategyCondition.triggeredPrice = confirmPrice;
        strategyCondition.message = `[Simulated] ${dir} 15M CHOCH + 2-Candle Confirmation Sequence fully validated for ${setup.symbol}`;
        setup.strategyProgress = progress;
        setup.status = 'CONFIRMED';
        await setup.save();

        const eventRecord = new AgentEvent({
          userId: setup.userId,
          setupId: setup._id,
          eventId: `STRATEGY_CONFIRMED-${Date.now()}-${setup._id}`,
          type: 'STRATEGY_CONFIRMED',
          symbol: setup.symbol,
          message: strategyCondition.message,
          price: confirmPrice,
          direction: dir,
        });
        await eventRecord.save();

        this.bus.emit('update', {
          type: 'setup:update',
          setupId: setup._id.toString(),
          userId: setup.userId.toString(),
          setup: setup.toObject(),
          event: eventRecord.toObject(),
        });
        return { setup, message: `Step 4 & 5 Triggered: Candle #2 confirmed! Setup is FULLY CONFIRMED & Entry ready!` };
      }
    }

    const conditions = [...setup.conditions].sort((a, b) => Number(a.order) - Number(b.order));
    const nextPending = conditions.find((c) => c.status === 'PENDING');
    if (!nextPending) {
      return { setup, message: 'All conditions are already confirmed!' };
    }

    let eventType = 'HIGH_BROKEN';
    let direction = setup.direction === 'SELL' ? 'BEARISH' : 'BULLISH';

    switch (nextPending.type) {
      case 'PREVIOUS_HIGH_BREAK':
        eventType = 'HIGH_BROKEN';
        break;
      case 'PREVIOUS_LOW_BREAK':
        eventType = 'LOW_BROKEN';
        break;
      case 'CHOCH':
        eventType = 'CHOCH_DETECTED';
        direction = nextPending.parameters?.direction || direction;
        break;
      case 'BOS':
        eventType = 'BOS_DETECTED';
        direction = nextPending.parameters?.direction || direction;
        break;
      case 'CANDLE_CONFIRMATION':
        eventType = 'CANDLE_CONFIRMED';
        break;
      case 'RETEST':
        eventType = 'RETEST_DETECTED';
        break;
      case 'CHOCH_2C_CONFIRMATION':
        eventType = 'STRATEGY_CONFIRMED';
        break;
      default:
        eventType = nextPending.type;
        break;
    }

    const currentPrice = (await this.provider.getSnapshot(setup.symbol))?.price || 100;
    const simulatedPrice = Number(currentPrice);

    await this.fire({
      id: `sim:${setup.symbol}:${Date.now()}`,
      type: eventType,
      symbol: setup.symbol,
      timeframe: nextPending.timeframe || setup.primaryTimeframe,
      price: simulatedPrice,
      direction,
      count: 2,
      message: `[Simulated] ${nextPending.name} triggered for ${setup.symbol} at $${simulatedPrice}`,
    });

    const updated = await Setup.findById(setupId);
    return { setup: updated, message: `${nextPending.name} triggered.` };
  }

  async fire(event) {
    if (!event || !event.symbol) return;

    try {
      const setups = await Setup.find({
        symbol: event.symbol,
        status: { $in: ['MONITORING', 'PARTIALLY_CONFIRMED', 'CONFIRMED'] },
      });

      for (const setup of setups) {
        const conditions = [...setup.conditions].sort((a, b) => Number(a.order) - Number(b.order));
        let canAdvance = true;

        for (const condition of conditions) {
          if (condition.status === 'TRIGGERED') continue;
          if (event.timeframe && condition.timeframe && condition.timeframe !== event.timeframe) continue;

          if (setup.conditionMode === 'SEQUENTIAL') {
            const earlierPending = conditions
              .slice(0, conditions.indexOf(condition))
              .some((item) => item.status !== 'TRIGGERED');

            if (earlierPending) {
              canAdvance = false;
              break;
            }
          }

          if (!evaluateConditionMatch(condition, event)) continue;

          condition.status = 'TRIGGERED';
          condition.triggeredAt = new Date();
          condition.triggeredPrice = event.price ?? null;
          condition.message = event.message || `${condition.name} triggered`;

          if (conditions.every((item) => item.status === 'TRIGGERED')) {
            setup.status = 'CONFIRMED';
          } else {
            setup.status = 'PARTIALLY_CONFIRMED';
          }

          await setup.save();

          const eventRecord = new AgentEvent({
            userId: setup.userId,
            setupId: setup._id,
            eventId: `${event.type}-${Date.now()}-${setup._id}`,
            type: event.type,
            symbol: setup.symbol,
            message: condition.message,
            price: event.price,
            direction: event.direction,
          });

          await eventRecord.save();

          this.bus.emit('update', {
            type: 'setup:update',
            setupId: setup._id.toString(),
            userId: setup.userId.toString(),
            setup: setup.toObject(),
            event: eventRecord.toObject(),
          });

          break;
        }

        if (!canAdvance) continue;
      }
    } catch (err) {
      console.warn(`StrategyEngine fire error for ${event.symbol}:`, err.message);
    }
  }
}
