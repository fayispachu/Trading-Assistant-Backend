import { EventEmitter } from 'node:events';
import { Setup, AgentEvent } from '../models/index.js';
import { User } from '../models/User.js';
import { normalizeSymbol, isNasdaqSymbol } from './market.js';
import { analyzeChochSetup, calculateTimeframeDirection } from './structure.js';
import { evaluateNqBulletStrategy } from './nqBullet.js';
import { sendSetupConfirmationEmail, sendSetupMilestoneEmail } from './email.js';

const MAX_JOURNAL_ENTRY_DEVIATION_R = 0.25;

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
    case 'NQ_BULLET_CONFIRMATION':
      return event.type === 'STRATEGY_CONFIRMED' || event.type === 'NQ_BULLET_CONFIRMED';
    default:
      if (condition.type.startsWith('CUSTOM_CONFIRMATION_') && event.type === condition.type) {
        return true;
      }
      return false;
  }
}

export function getNewChochMilestones(previousProgress = {}, progress = {}) {
  const milestones = [];
  const chochTime = Number(progress.chochTime);

  if (Number.isFinite(chochTime) && chochTime > 0 && chochTime !== Number(previousProgress.chochTime)) {
    milestones.push({
      key: `CHOCH-${chochTime}`,
      type: 'CHOCH_DETECTED',
      stage: 'CHOCH',
      price: progress.chochPrice,
      occurredAt: new Date(chochTime),
      message: `${progress.direction} 15M CHOCH body closed at ${progress.chochPrice} beyond swing level ${progress.swingLevel}.`,
    });
  }

  const candle1 = progress.candle1;
  const candle1Time = Number(candle1?.closeTime);
  if (
    candle1?.held &&
    candle1?.isDirectional &&
    Number.isFinite(candle1Time) &&
    candle1Time > 0 &&
    candle1Time !== Number(previousProgress.candle1?.closeTime)
  ) {
    milestones.push({
      key: `CANDLE_1-${candle1Time}`,
      type: 'CONFIRMATION_STEP',
      stage: 'CANDLE_1',
      price: candle1.close,
      occurredAt: new Date(candle1Time),
      message: `${progress.direction} 15M confirmation candle #1 completed at ${candle1.close} and held the CHOCH structure.`,
    });
  }

  return milestones;
}

export function isNewOpposingChoch(setup, previousProgress = {}, opposingProgress = {}) {
  const previousChochTime = Number(previousProgress.chochTime);
  const hasPreviousChoch = Number.isFinite(previousChochTime) && previousChochTime > 0;
  const baselineDirection = hasPreviousChoch
    ? previousProgress.direction
    : setup.direction;
  if (!['BUY', 'SELL'].includes(baselineDirection)) return false;

  const startedAt = setup.strategyStartedAt || setup.createdAt;
  const referenceTime = hasPreviousChoch
    ? previousChochTime
    : startedAt
      ? new Date(startedAt).getTime()
      : 0;
  const opposingDirection = baselineDirection === 'BUY' ? 'SELL' : 'BUY';

  return (
    opposingProgress.direction === opposingDirection &&
    Number(opposingProgress.chochTime) > referenceTime
  );
}

async function triggerConfirmationEmail(setup, eventRecord, targets) {
  try {
    const userRecord = await User.findById(setup.userId);
    if (!userRecord || userRecord.emailNotifications === false) return;

    sendSetupConfirmationEmail({
      to: userRecord.alertEmail || userRecord.email,
      setup: typeof setup.toObject === 'function' ? setup.toObject() : setup,
      event: typeof eventRecord?.toObject === 'function' ? eventRecord.toObject() : eventRecord,
      targets: targets || setup.strategyProgress?.targets,
      userConfig: userRecord.emailConfig || {},
    }).catch((emailErr) => {
      console.warn('Confirmation email dispatch warning:', emailErr.message);
    });
  } catch (err) {
    console.warn('triggerConfirmationEmail error:', err.message);
  }
}

async function triggerMilestoneEmail(setup, eventRecord) {
  try {
    const userRecord = await User.findById(setup.userId);
    if (!userRecord || userRecord.emailNotifications === false) return;

    sendSetupMilestoneEmail({
      to: userRecord.alertEmail || userRecord.email,
      setup: typeof setup.toObject === 'function' ? setup.toObject() : setup,
      event: typeof eventRecord?.toObject === 'function' ? eventRecord.toObject() : eventRecord,
      userConfig: userRecord.emailConfig || {},
    }).catch((emailErr) => {
      console.warn('Milestone email dispatch warning:', emailErr.message);
    });
  } catch (err) {
    console.warn('triggerMilestoneEmail error:', err.message);
  }
}

async function saveNewAgentEvent(eventData) {
  const eventRecord = new AgentEvent(eventData);
  try {
    await eventRecord.save();
    return eventRecord;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

export function buildJournalTradePlan(setup, currentPrice) {
  const progress = setup.strategyProgress || {};
  const direction = progress.direction || setup.direction;
  const stopLoss = Number(progress.targets?.stopLoss);
  const setupEntryPrice = [
    progress.candle2?.close,
    progress.targets?.entryPrice,
    progress.chochPrice,
    progress.swingLevel,
  ]
    .map(Number)
    .find((price) => Number.isFinite(price) && price > 0);
  const hasValidSetupLevels =
    Number.isFinite(stopLoss) &&
    Number.isFinite(setupEntryPrice) &&
    ((direction === 'BUY' && stopLoss < setupEntryPrice) ||
      (direction === 'SELL' && stopLoss > setupEntryPrice));
  const setupRisk = hasValidSetupLevels ? Math.abs(setupEntryPrice - stopLoss) : null;
  const livePrice = Number(currentPrice);
  const hasLivePrice = Number.isFinite(livePrice) && livePrice > 0;
  const priceMovedTooFar =
    hasValidSetupLevels &&
    hasLivePrice &&
    Math.abs(livePrice - setupEntryPrice) > setupRisk * MAX_JOURNAL_ENTRY_DEVIATION_R;
  const entryPrice = hasValidSetupLevels && !priceMovedTooFar
    ? (hasLivePrice ? livePrice : setupEntryPrice)
    : undefined;
  const validLevels =
    Number.isFinite(entryPrice) &&
    ((direction === 'BUY' && stopLoss < entryPrice) ||
      (direction === 'SELL' && stopLoss > entryPrice));
  const risk = validLevels ? Math.abs(entryPrice - stopLoss) : null;

  return {
    setupName: setup.name,
    timeframe: setup.primaryTimeframe || '15M',
    tradeEntryPrice: validLevels ? entryPrice : undefined,
    tradeStopLoss: Number.isFinite(stopLoss) ? stopLoss : undefined,
    tradeTakeProfit: validLevels
      ? entryPrice + (direction === 'BUY' ? 1 : -1) * risk * 3
      : undefined,
    tradeRiskReward: '1:3',
    tradeEntryStatus: priceMovedTooFar
      ? 'SKIPPED_PRICE_MOVED'
      : validLevels
        ? 'READY'
        : 'SKIPPED_INVALID_SETUP',
    journalOutcome: 'OPEN',
    journalLastPrice: validLevels ? entryPrice : undefined,
  };
}

export function evaluateJournalTrade(entry, marketData) {
  const entryPrice = Number(entry.tradeEntryPrice);
  const stopLoss = Number(entry.tradeStopLoss);
  const takeProfit = Number(entry.tradeTakeProfit);
  const price = Number(marketData.price);
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(takeProfit) ||
    !Number.isFinite(price)
  ) {
    return null;
  }

  const low = marketData.low != null && Number.isFinite(Number(marketData.low))
    ? Number(marketData.low)
    : price;
  const high = marketData.high != null && Number.isFinite(Number(marketData.high))
    ? Number(marketData.high)
    : price;
  if (!['BUY', 'SELL'].includes(entry.direction)) return null;
  const isBuy = entry.direction === 'BUY';
  const hasCandleRange = marketData.low != null || marketData.high != null;
  const previousPrice = Number(entry.journalLastPrice);
  const hasPreviousPrice = Number.isFinite(previousPrice);
  const stopHit = hasCandleRange
    ? isBuy ? low <= stopLoss : high >= stopLoss
    : isBuy
      ? hasPreviousPrice ? previousPrice > stopLoss && price <= stopLoss : price <= stopLoss
      : hasPreviousPrice ? previousPrice < stopLoss && price >= stopLoss : price >= stopLoss;
  const targetHit = hasCandleRange
    ? isBuy ? high >= takeProfit : low <= takeProfit
    : isBuy
      ? hasPreviousPrice ? previousPrice < takeProfit && price >= takeProfit : price >= takeProfit
      : hasPreviousPrice ? previousPrice > takeProfit && price <= takeProfit : price <= takeProfit;
  if (!stopHit && !targetHit) return null;

  const outcome = stopHit ? 'LOSS' : 'WIN';
  return {
    outcome,
    resultR: outcome === 'WIN' ? 3 : -1,
    exitPrice: outcome === 'WIN' ? takeProfit : stopLoss,
    closedAt: marketData.time ? new Date(marketData.time) : new Date(),
  };
}

export class StrategyEngine {
  constructor(provider) {
    this.provider = provider;
    this.bus = new EventEmitter();
    this.marketState = new Map();
    this.candleState = new Map();
    this.candleHistory = new Map();
    this.journalSubscriptions = new Set();
    this.journalBackfillSymbols = new Set();
    this.journalBackfillComplete = false;
    this.journalStartAt = null;

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
          if (isNasdaqSymbol(symbol)) {
            this.processNqBulletSetups(symbol, candles, frameHistory).catch((err) => {
              console.warn('StrategyEngine processNqBulletSetups onRefresh error:', err.message);
            });
          } else {
            this.processChochSetups(symbol, candles, frameHistory).catch((err) => {
              console.warn('StrategyEngine processChochSetups onRefresh error:', err.message);
            });
          }
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

  async settleJournalTrades(symbol, marketData) {
    if (
      !this.provider ||
      !this.journalStartAt ||
      !this.journalBackfillComplete ||
      this.journalBackfillSymbols.has(symbol)
    ) return;

    try {
      const entries = await AgentEvent.find({
        symbol: normalizeSymbol(symbol),
        type: 'STRATEGY_CONFIRMED',
        createdAt: { $gte: this.journalStartAt },
        journalOutcome: 'OPEN',
        tradeEntryPrice: { $type: 'number' },
        tradeStopLoss: { $type: 'number' },
        tradeTakeProfit: { $type: 'number' },
      }).lean();

      for (const entry of entries) {
        const eventTime = new Date(entry.createdAt).getTime();
        const observationStart = marketData.openTime ?? marketData.time;
        if (observationStart != null && eventTime >= Number(observationStart)) {
          continue;
        }

        const result = evaluateJournalTrade(entry, marketData);
        if (!result) {
          const price = Number(marketData.price);
          if (Number.isFinite(price)) {
            await AgentEvent.updateOne(
              { _id: entry._id, journalOutcome: 'OPEN' },
              { $set: { journalLastPrice: price } }
            );
          }
          continue;
        }

        const updated = await AgentEvent.findOneAndUpdate(
          { _id: entry._id, journalOutcome: 'OPEN' },
          {
            $set: {
              journalOutcome: result.outcome,
              journalResultR: result.resultR,
              tradeExitPrice: result.exitPrice,
              journalClosedAt: result.closedAt,
              journalResultSource: 'AUTO',
            },
          },
          { new: true }
        );

        if (updated) {
          this.publishJournalUpdate(updated);
        }
      }
    } catch (error) {
      console.warn('Journal outcome settlement error:', error.message);
    }
  }

  async backfillJournalTrades(userId, legacyEntries = []) {
    if (!this.journalStartAt) return;
    const userFilter = userId ? { userId } : {};
    const entriesByEventId = new Map();
    const entriesBySetupId = new Map();
    for (const entry of legacyEntries) {
      const eventIdMatch = String(entry.id || '').match(/^[a-f\d]{24}-([a-f\d]{24})$/i);
      if (eventIdMatch) entriesByEventId.set(eventIdMatch[1], entry);
      if (entry.setupId) {
        const setupEntries = entriesBySetupId.get(String(entry.setupId)) || [];
        setupEntries.push(entry);
        entriesBySetupId.set(String(entry.setupId), setupEntries);
      }
    }

    const oldEvents = await AgentEvent.find({
      ...userFilter,
      type: 'STRATEGY_CONFIRMED',
      createdAt: { $gte: this.journalStartAt },
      journalResultSource: { $ne: 'AUTO' },
    }).sort({ createdAt: 1 });

    for (const event of oldEvents) {
      if (isNasdaqSymbol(event.symbol)) continue;
      const needsResultReset =
        event.journalOutcome !== 'OPEN' ||
        event.journalResultSource ||
        event.journalResultR != null ||
        event.tradeExitPrice != null ||
        event.journalClosedAt != null;
      if (needsResultReset) {
        event.journalOutcome = 'OPEN';
        event.journalResultSource = undefined;
        event.journalResultR = undefined;
        event.tradeExitPrice = undefined;
        event.journalClosedAt = undefined;
        await event.save();
      }

      const hasCompletePlan =
        ['BUY', 'SELL'].includes(event.direction) &&
        Number.isFinite(event.tradeEntryPrice) &&
        Number.isFinite(event.tradeStopLoss) &&
        Number.isFinite(event.tradeTakeProfit);
      if (hasCompletePlan) continue;

      const legacyEntry =
        entriesByEventId.get(String(event._id)) ||
        entriesBySetupId.get(String(event.setupId))?.find((entry) => {
          const date = new Date(entry.confirmedAt).getTime();
          return Number.isFinite(date) &&
            Math.abs(date - new Date(event.createdAt).getTime()) < 60000;
        });
      const setupQuery = { _id: event.setupId, ...userFilter };
      const setup = await Setup.findOne(setupQuery).lean();
      const progress = setup?.strategyProgress || {};
      const directionCandidates = [
        event.direction,
        legacyEntry?.direction,
        progress.direction,
        setup?.direction,
      ];
      const rawDirection = directionCandidates.find((direction) =>
        ['BUY', 'SELL', 'BULLISH', 'BEARISH'].includes(String(direction || '').toUpperCase())
      );
      const direction = ['BUY', 'BULLISH'].includes(String(rawDirection || '').toUpperCase())
        ? 'BUY'
        : ['SELL', 'BEARISH'].includes(String(rawDirection || '').toUpperCase())
          ? 'SELL'
          : null;
      const entryCandidates = [
        event.tradeEntryPrice,
        legacyEntry?.entryPrice,
        progress.candle2?.close,
        progress.targets?.entryPrice,
        progress.chochPrice,
        event.price,
        progress.swingLevel,
      ];
      const entryPrice = entryCandidates
        .map(Number)
        .find((price) => Number.isFinite(price) && price > 0);
      const stopLoss = [
        event.tradeStopLoss,
        legacyEntry?.stopLoss,
        progress.targets?.stopLoss,
      ].map(Number).find((price) => Number.isFinite(price) && price > 0);
      const validLevels =
        direction &&
        Number.isFinite(entryPrice) &&
        Number.isFinite(stopLoss) &&
        ((direction === 'BUY' && stopLoss < entryPrice) ||
          (direction === 'SELL' && stopLoss > entryPrice));
      if (!validLevels) continue;

      const journalPlan = buildJournalTradePlan(
        {
          ...setup,
          direction,
          strategyProgress: {
            ...progress,
            direction,
            targets: { ...progress.targets, stopLoss },
          },
        },
        entryPrice
      );
      if (!Number.isFinite(journalPlan.tradeEntryPrice)) continue;

      event.setupName = event.setupName || legacyEntry?.name || setup?.name || `${event.symbol} setup`;
      event.timeframe = event.timeframe || legacyEntry?.timeframe || setup?.primaryTimeframe || '15M';
      event.direction = direction;
      event.tradeEntryPrice = journalPlan.tradeEntryPrice;
      event.tradeStopLoss = journalPlan.tradeStopLoss;
      event.tradeTakeProfit = journalPlan.tradeTakeProfit;
      event.tradeRiskReward = journalPlan.tradeRiskReward;
      event.tradeEntryStatus = journalPlan.tradeEntryStatus;
      event.journalOutcome = 'OPEN';
      event.journalResultR = undefined;
      event.tradeExitPrice = undefined;
      event.journalClosedAt = undefined;
      event.journalResultSource = undefined;
      event.journalLastPrice = event.journalLastPrice ?? journalPlan.tradeEntryPrice;
      await event.save();
    }

    const openEvents = await AgentEvent.find({
      ...userFilter,
      type: 'STRATEGY_CONFIRMED',
      createdAt: { $gte: this.journalStartAt },
      journalOutcome: 'OPEN',
      tradeEntryPrice: { $type: 'number' },
      tradeStopLoss: { $type: 'number' },
      tradeTakeProfit: { $type: 'number' },
    }).lean();

    const journalSymbols = new Set(
      openEvents
        .filter((event) => !isNasdaqSymbol(event.symbol))
        .map((event) => normalizeSymbol(event.symbol))
    );
    for (const symbol of journalSymbols) {
      this.journalBackfillSymbols.add(symbol);
      if (this.provider && !this.journalSubscriptions.has(symbol)) {
        try {
          await this.provider.subscribe(symbol, '15M');
          this.journalSubscriptions.add(symbol);
        } catch (error) {
          console.warn(`Journal feed subscription skipped for ${symbol}:`, error.message);
        }
      }
      const snapshot = this.provider?.getSnapshot?.(symbol);
      if (snapshot) this.seedFromSnapshot(symbol, snapshot);
    }

    for (const event of openEvents) {
      const symbol = normalizeSymbol(event.symbol);
      if (isNasdaqSymbol(symbol)) continue;
      const candles = this.candleHistory.get(symbol)?.get('15M') || [];
      const confirmedAt = new Date(event.createdAt).getTime();
      const lastEvaluatedAt = Number(event.journalLastEvaluatedAt) || 0;
      const historyComplete = candles.length > 0 && Number(candles[0].openTime) <= confirmedAt;
      let latestEvaluatedAt = lastEvaluatedAt;
      let settled = false;
      if (historyComplete) {
        for (const candle of candles) {
          if (
            Number(candle.openTime) < confirmedAt ||
            Number(candle.closeTime) <= lastEvaluatedAt
          ) {
            continue;
          }
          latestEvaluatedAt = Math.max(latestEvaluatedAt, Number(candle.closeTime) || 0);
          const result = evaluateJournalTrade(event, {
            price: candle.close,
            low: candle.low,
            high: candle.high,
            time: candle.closeTime,
          });
          if (!result) continue;

          const updated = await AgentEvent.findOneAndUpdate(
            { _id: event._id, journalOutcome: 'OPEN' },
            {
              $set: {
                journalOutcome: result.outcome,
                journalResultR: result.resultR,
                tradeExitPrice: result.exitPrice,
                journalClosedAt: result.closedAt,
                journalResultSource: 'AUTO',
                journalLastEvaluatedAt: latestEvaluatedAt,
              },
            },
            { new: true }
          );
          if (updated) this.publishJournalUpdate(updated);
          settled = Boolean(updated);
          break;
        }
      }

      if (settled) continue;
      const latestCandle = candles.at(-1);
      if (latestCandle) {
        latestEvaluatedAt = Math.max(latestEvaluatedAt, Number(latestCandle.closeTime) || 0);
      }
      const currentPrice = Number(this.provider?.getSnapshot?.(symbol)?.price);
      await AgentEvent.updateOne(
        { _id: event._id, journalOutcome: 'OPEN' },
        {
          $set: {
            journalLastPrice: Number.isFinite(currentPrice)
              ? currentPrice
              : event.journalLastPrice ?? event.tradeEntryPrice,
            journalLastEvaluatedAt: latestEvaluatedAt,
          },
        }
      );
    }

    for (const symbol of journalSymbols) this.journalBackfillSymbols.delete(symbol);
    this.journalBackfillComplete = true;
  }

  publishJournalUpdate(entry) {
    this.bus.emit('update', {
      type: 'journal:update',
      userId: String(entry.userId),
      journalEntry: entry.toObject(),
    });
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

      const isNasdaq = isNasdaqSymbol(record.symbol);
      const frameHistory = this.candleHistory.get(record.symbol) || new Map();
      const candles15m = frameHistory.get('15M') || [];
      const candles1h = frameHistory.get('1H') || [];

      // 1. Check if setup is NQ Bullet
      const nqCondition = record.conditions.find(
        (c) => c.type === 'NQ_BULLET_CONFIRMATION'
      );
      if (nqCondition || isNasdaq) {
        const nqProgress = evaluateNqBulletStrategy(candles15m, candles1h, nqCondition?.parameters || {});
        record.strategyProgress = nqProgress;

        if (nqProgress.confirmed) {
          if (nqCondition) {
            nqCondition.status = 'TRIGGERED';
            nqCondition.triggeredAt = new Date();
            nqCondition.triggeredPrice = nqProgress.currentPrice;
            nqCondition.message = `NQ Bullet BUY/SELL Confirmed! Entry: ${nqProgress.targets.entryPrice} | SL: ${nqProgress.targets.stopLoss} | TP: ${nqProgress.targets.takeProfit}`;
          }
          record.status = 'CONFIRMED';
        } else if (nqProgress.breakoutSeen || nqProgress.boxReady) {
          record.status = 'PARTIALLY_CONFIRMED';
        }

        await record.save();

        let eventRecord = null;
        if (record.status === 'CONFIRMED') {
          const currentPrice = this.provider.getSnapshot(record.symbol)?.price;
          eventRecord = new AgentEvent({
            userId: record.userId,
            setupId: record._id,
            eventId: `NQ_BULLET_CONFIRMED-${Date.now()}-${record._id}`,
            type: 'STRATEGY_CONFIRMED',
            symbol: record.symbol,
            message: nqCondition?.message || 'NQ Bullet strategy fully confirmed!',
            price: nqProgress.currentPrice,
            direction: nqProgress.direction,
          });
          await eventRecord.save();
          triggerConfirmationEmail(record, eventRecord, nqProgress.targets);
        }

        this.bus.emit('update', {
          type: 'setup-start',
          setupId: record._id.toString(),
          userId: record.userId.toString(),
          setup: record.toObject(),
          event: eventRecord?.toObject(),
        });
        return;
      }

      // 2. Standard 15M CHOCH sequence for XRP
      const strategyCondition = record.conditions.find(
        (condition) => condition.type === 'CHOCH_2C_CONFIRMATION'
      );
      if (strategyCondition) {
        record.strategyProgress = analyzeChochSetup(
          candles15m,
          record.direction,
          { ...strategyCondition.parameters }
        );
        const oneHourDir = calculateTimeframeDirection(candles1h);
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

      if (strategyCondition) {
        await this.publishChochMilestones(
          record,
          getNewChochMilestones({}, record.strategyProgress || {})
        );
      }

      let eventRecord = null;
      if (record.status === 'CONFIRMED' && strategyCondition) {
        const currentPrice = this.provider.getSnapshot(record.symbol)?.price;
        eventRecord = await saveNewAgentEvent({
          userId: record.userId,
          setupId: record._id,
          eventId: `STRATEGY_CONFIRMED-${record.strategyProgress.chochTime}-${record._id}`,
          type: 'STRATEGY_CONFIRMED',
          symbol: record.symbol,
          message: strategyCondition.message,
          price: record.strategyProgress.chochPrice,
          direction: record.strategyProgress.direction,
          ...buildJournalTradePlan(record, currentPrice),
        });
        if (eventRecord) {
          triggerConfirmationEmail(record, eventRecord, record.strategyProgress?.targets);
        }
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

  async publishChochMilestones(setup, milestones) {
    for (const milestone of milestones) {
      const eventRecord = await saveNewAgentEvent({
        userId: setup.userId,
        setupId: setup._id,
        eventId: `${milestone.key}-${setup._id}`,
        type: milestone.type,
        stage: milestone.stage,
        symbol: setup.symbol,
        timeframe: '15M',
        message: milestone.message,
        price: milestone.price,
        direction: setup.strategyProgress?.direction,
        occurredAt: milestone.occurredAt,
      });
      if (!eventRecord) continue;

      await triggerMilestoneEmail(setup, eventRecord);
      this.bus.emit('update', {
        type: 'setup:update',
        setupId: setup._id.toString(),
        userId: setup.userId.toString(),
        setup: setup.toObject(),
        event: eventRecord.toObject(),
      });
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
      await this.settleJournalTrades(tick.symbol, {
        price: tick.price,
        time: tick.time,
      });

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
      if (timeframe === '15M') {
        await this.settleJournalTrades(candle.symbol, {
          price: candle.close,
          low: candle.low,
          high: candle.high,
          time: candle.closeTime,
          openTime: candle.openTime,
        });
      }

      const frameHistory = this.candleHistory.get(candle.symbol) || new Map();
      const candles = frameHistory.get(timeframe) || [];
      if (candles.at(-1)?.closeTime >= candle.closeTime) return;
      const previousCandle = candles.at(-1);
      candles.push(candle);
      if (candles.length > 500) candles.shift();
      frameHistory.set(timeframe, candles);
      this.candleHistory.set(candle.symbol, frameHistory);

      if (timeframe === '15M') {
        if (isNasdaqSymbol(candle.symbol)) {
          await this.processNqBulletSetups(candle.symbol, candles, frameHistory);
        } else {
          await this.processChochSetups(candle.symbol, candles, frameHistory);
        }
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

  async processNqBulletSetups(symbol, candles, frameHistory) {
    const setups = await Setup.find({
      symbol,
      status: { $in: ['MONITORING', 'PARTIALLY_CONFIRMED'] },
    });
    const candles1h = frameHistory.get('1H') || [];

    for (const setup of setups) {
      const condition = setup.conditions.find((c) => c.type === 'NQ_BULLET_CONFIRMATION') || setup.conditions[0];
      const progress = evaluateNqBulletStrategy(candles, candles1h, condition?.parameters || {});
      setup.strategyProgress = progress;

      if (progress.confirmed && setup.status !== 'CONFIRMED') {
        if (condition) {
          condition.status = 'TRIGGERED';
          condition.triggeredAt = new Date();
          condition.triggeredPrice = progress.currentPrice;
          condition.message = `NQ Bullet ${progress.direction} Confirmed! Entry: ${progress.targets.entryPrice} | SL: ${progress.targets.stopLoss} | TP: ${progress.targets.takeProfit}`;
        }
        setup.status = 'CONFIRMED';
        await setup.save();

        const eventRecord = new AgentEvent({
          userId: setup.userId,
          setupId: setup._id,
          eventId: `NQ_BULLET_CONFIRMED-${Date.now()}-${setup._id}`,
          type: 'STRATEGY_CONFIRMED',
          symbol: setup.symbol,
          message: condition?.message || 'NQ Bullet strategy fully confirmed!',
          price: progress.currentPrice,
          direction: progress.direction,
        });
        await eventRecord.save();
        triggerConfirmationEmail(setup, eventRecord, progress.targets);

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

  async processChochSetups(symbol, candles, frameHistory) {
    const setups = await Setup.find({
      symbol,
      status: { $in: ['MONITORING', 'PARTIALLY_CONFIRMED', 'CONFIRMED'] },
      'conditions.type': 'CHOCH_2C_CONFIRMATION',
    });
    const oneHourDir = calculateTimeframeDirection(frameHistory.get('1H'));
    const fourHourDir = calculateTimeframeDirection(frameHistory.get('4H'));

    for (const setup of setups) {
      const condition = setup.conditions.find((item) => item.type === 'CHOCH_2C_CONFIRMATION');
      if (!condition) continue;

      const previousProgress = setup.strategyProgress || {};
      const previousChochTime = Number(previousProgress.chochTime);
      const hasPreviousChoch = Number.isFinite(previousChochTime) && previousChochTime > 0;
      const baselineDirection = hasPreviousChoch ? previousProgress.direction : setup.direction;
      if (['BUY', 'SELL'].includes(baselineDirection)) {
        const referenceTime = hasPreviousChoch
          ? previousChochTime
          : setup.strategyStartedAt
            ? new Date(setup.strategyStartedAt).getTime()
            : 0;
        const oppositeDirection = baselineDirection === 'BUY' ? 'SELL' : 'BUY';
        const opposingProgress = analyzeChochSetup(candles, oppositeDirection, {
          ...condition.parameters,
          activeAfter: referenceTime,
        });

        if (isNewOpposingChoch(setup, previousProgress, opposingProgress)) {
          const reversalTime = Number(opposingProgress.chochTime);
          const reversalEvent = await saveNewAgentEvent({
            userId: setup.userId,
            setupId: setup._id,
            eventId: `OPPOSING_CHOCH-${reversalTime}-${setup._id}`,
            type: 'OPPOSING_CHOCH',
            stage: 'OPPOSING_CHOCH',
            symbol: setup.symbol,
            timeframe: '15M',
            message: `Opposing 15M CHOCH observed against the ${baselineDirection} setup direction at ${opposingProgress.chochPrice}. Informational only; this does not confirm or invalidate the setup.`,
            price: opposingProgress.chochPrice,
            direction: opposingProgress.direction,
            occurredAt: new Date(reversalTime),
          });
          if (reversalEvent) {
            this.bus.emit('update', {
              type: 'setup:reversal',
              setupId: setup._id.toString(),
              userId: setup.userId.toString(),
              event: reversalEvent.toObject(),
            });
          }
        }
      }

      if (condition.status === 'TRIGGERED') continue;

      const progress = analyzeChochSetup(candles, setup.direction, {
        ...condition.parameters,
        activeAfter: setup.strategyStartedAt?.getTime(),
      });
      const milestones = getNewChochMilestones(previousProgress, progress);
      progress.timeframeBias = { '1H': oneHourDir, '4H': fourHourDir };
      setup.strategyProgress = progress;

      if (progress.confirmed) {
        condition.status = 'TRIGGERED';
        condition.triggeredAt = new Date();
        condition.triggeredPrice = progress.chochPrice;
        condition.message = `${progress.direction} CHOCH confirmed: body closed beyond ${progress.direction === 'SELL' ? 'HL' : 'LH'} at $${progress.swingLevel}; ${progress.confirmationCandles} completed 15M candles followed. Setup Area: $${progress.setupArea?.bottom} - $${progress.setupArea?.top}. HTF: 1H ${oneHourDir.direction}, 4H ${fourHourDir.direction}.`;
        setup.status = 'CONFIRMED';
        await setup.save();
        await this.publishChochMilestones(setup, milestones);

        const eventRecord = await saveNewAgentEvent({
          userId: setup.userId,
          setupId: setup._id,
          eventId: `STRATEGY_CONFIRMED-${progress.chochTime}-${setup._id}`,
          type: 'STRATEGY_CONFIRMED',
          symbol: setup.symbol,
          message: condition.message,
          price: progress.chochPrice,
          direction: progress.direction,
          ...buildJournalTradePlan(
            setup,
            this.provider.getSnapshot(setup.symbol)?.price
          ),
        });
        if (eventRecord) {
          triggerConfirmationEmail(setup, eventRecord, progress.targets);
        }

        if (eventRecord) {
          this.bus.emit('update', {
            type: 'setup:update',
            setupId: setup._id.toString(),
            userId: setup.userId.toString(),
            setup: setup.toObject(),
            event: eventRecord.toObject(),
          });
        }
        continue;
      }

      await setup.save();
      await this.publishChochMilestones(setup, milestones);

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

    const isNasdaq = isNasdaqSymbol(setup.symbol);
    const nqCondition = setup.conditions.find((c) => c.type === 'NQ_BULLET_CONFIRMATION');

    // 1. Simulation for NQ Bullet Setup
    if (nqCondition || isNasdaq) {
      const snapshot = await this.provider.getSnapshot(setup.symbol);
      const currentPrice = Number(snapshot?.price || 20485.50);
      const dir = setup.direction === 'BOTH' || setup.direction === 'BUY' ? 'BUY' : 'SELL';
      const isBuy = dir === 'BUY';

      let progress = setup.strategyProgress || { stage: 0 };
      const stage = (progress.stage || 0) + 1;

      const boxHigh = Number((currentPrice + 45).toFixed(2));
      const boxLow = Number((currentPrice - 35).toFixed(2));
      const stopLoss = isBuy ? boxLow : boxHigh;
      const risk = Math.abs(currentPrice - stopLoss);
      const takeProfit = isBuy ? Number((currentPrice + risk * 2.0).toFixed(2)) : Number((currentPrice - risk * 2.0).toFixed(2));

      if (stage === 1) {
        progress = {
          stage: 1,
          strategy: 'NQ_BULLET',
          boxReady: true,
          boxHigh,
          boxLow,
          boxRange: Number((boxHigh - boxLow).toFixed(2)),
          currentPrice,
          inTradeSession: true,
          trend: isBuy ? 'UPTREND' : 'DOWNTREND',
          ema50: Number((currentPrice - (isBuy ? 15 : -15)).toFixed(2)),
          breakoutSeen: false,
          retestConfirmed: false,
          confirmed: false,
          direction: dir,
          targets: { entryPrice: currentPrice, stopLoss, takeProfit, riskReward: '1:2.0', riskPoints: risk },
          sequenceSteps: [
            { id: 1, name: 'Daily Box Formation (10:30 - 10:45 IST)', status: 'TRIGGERED', desc: `Box Formed! High: ${boxHigh} | Low: ${boxLow} (${(boxHigh - boxLow).toFixed(2)} pts)` },
            { id: 2, name: 'Trading Session (10:45 - 15:15 IST)', status: 'TRIGGERED', desc: 'Trading Session Active (IST)' },
            { id: 3, name: '50 EMA Trend Filter', status: 'PENDING', desc: 'Awaiting trend confirmation' },
            { id: 4, name: 'Box Breakout & Zone Retest', status: 'PENDING', desc: 'Awaiting breakout beyond box' },
            { id: 5, name: '1H Major Levels & Execution', status: 'PENDING', desc: 'Awaiting execution confirmation' },
          ],
        };
        setup.strategyProgress = progress;
        setup.status = 'PARTIALLY_CONFIRMED';
        await setup.save();
        this.bus.emit('update', { type: 'setup:progress', setupId: setup._id.toString(), userId: setup.userId.toString(), setup: setup.toObject() });
        return { setup, message: `Step 1 Triggered: Daily Box established (${boxHigh} - ${boxLow}) for ${setup.symbol}` };
      } else if (stage === 2) {
        progress.stage = 2;
        progress.breakoutSeen = true;
        progress.breakoutDir = isBuy ? 1 : -1;
        progress.sequenceSteps[2].status = 'TRIGGERED';
        progress.sequenceSteps[2].desc = `50 EMA (${progress.ema50}) Aligned with ${dir} Trend`;
        progress.sequenceSteps[3].status = 'PARTIAL';
        progress.sequenceSteps[3].desc = `Breakout seen (${isBuy ? 'above ' + boxHigh : 'below ' + boxLow}). Awaiting retest touch.`;
        setup.strategyProgress = progress;
        setup.status = 'PARTIALLY_CONFIRMED';
        await setup.save();
        this.bus.emit('update', { type: 'setup:progress', setupId: setup._id.toString(), userId: setup.userId.toString(), setup: setup.toObject() });
        return { setup, message: `Step 2 Triggered: ${dir} Breakout beyond Box & 50 EMA confirmed!` };
      } else {
        // Full confirmation
        progress.stage = 3;
        progress.retestConfirmed = true;
        progress.confirmed = true;
        progress.sequenceSteps[3].status = 'TRIGGERED';
        progress.sequenceSteps[3].desc = `Zone Retest Confirmed! ${isBuy ? 'Tested Box High (' + boxHigh + ')' : 'Tested Box Low (' + boxLow + ')'} and held.`;
        progress.sequenceSteps[4].status = 'TRIGGERED';
        progress.sequenceSteps[4].desc = `100% Confirmed! Entry: ${currentPrice} | SL: ${stopLoss} | TP: ${takeProfit} (1:2 R:R)`;

        if (nqCondition) {
          nqCondition.status = 'TRIGGERED';
          nqCondition.triggeredAt = new Date();
          nqCondition.triggeredPrice = currentPrice;
          nqCondition.message = `[Simulated] NQ Bullet ${dir} Confirmed! Entry: ${currentPrice} | SL: ${stopLoss} | TP: ${takeProfit}`;
        }
        setup.strategyProgress = progress;
        setup.status = 'CONFIRMED';
        await setup.save();

        const eventRecord = new AgentEvent({
          userId: setup.userId,
          setupId: setup._id,
          eventId: `STRATEGY_CONFIRMED-${Date.now()}-${setup._id}`,
          type: 'STRATEGY_CONFIRMED',
          symbol: setup.symbol,
          message: `[Simulated] NQ Bullet ${dir} Setup FULLY CONFIRMED! Entry: ${currentPrice} | SL: ${stopLoss} | TP: ${takeProfit}`,
          price: currentPrice,
          direction: dir,
        });
        await eventRecord.save();

        // Send email alert!
        triggerConfirmationEmail(setup, eventRecord, progress.targets);

        this.bus.emit('update', {
          type: 'setup:update',
          setupId: setup._id.toString(),
          userId: setup.userId.toString(),
          setup: setup.toObject(),
          event: eventRecord.toObject(),
        });
        return { setup, message: `Step 3 Triggered: NQ Bullet Retest Confirmed! All confirmations met & Email sent!` };
      }
    }

    // 2. Simulation for XRP 15M CHOCH Setup
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
            entryPrice: currentPrice,
            stopLoss: isSell ? swingAnchor : swingLevel,
            takeProfit: isSell ? swingLevel - 2 * Math.abs(swingAnchor - swingLevel) : swingLevel + 2 * Math.abs(swingAnchor - swingLevel),
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
          ...buildJournalTradePlan(
            setup,
            this.provider.getSnapshot(setup.symbol)?.price
          ),
        });
        await eventRecord.save();

        // Send email alert!
        triggerConfirmationEmail(setup, eventRecord, progress.targets);

        this.bus.emit('update', {
          type: 'setup:update',
          setupId: setup._id.toString(),
          userId: setup.userId.toString(),
          setup: setup.toObject(),
          event: eventRecord.toObject(),
        });
        return { setup, message: `Step 4 & 5 Triggered: Candle #2 confirmed! Setup is FULLY CONFIRMED & Email sent!` };
      }
    }

    // 3. Fallback standard condition
    const conditions = [...setup.conditions].sort((a, b) => Number(a.order) - Number(b.order));
    const nextPending = conditions.find((c) => c.status === 'PENDING');
    if (!nextPending) {
      return { setup, message: 'All conditions are already confirmed!' };
    }

    const currentPrice = (await this.provider.getSnapshot(setup.symbol))?.price || 100;
    const simulatedPrice = Number(currentPrice);

    await this.fire({
      id: `sim:${setup.symbol}:${Date.now()}`,
      type: nextPending.type,
      symbol: setup.symbol,
      timeframe: nextPending.timeframe || setup.primaryTimeframe,
      price: simulatedPrice,
      direction: setup.direction === 'SELL' ? 'BEARISH' : 'BULLISH',
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

          if (setup.status === 'CONFIRMED') {
            triggerConfirmationEmail(setup, eventRecord, setup.strategyProgress?.targets);
          }

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
