import { EventEmitter } from 'node:events';
const DELTA_API_BASE = process.env.DELTA_API_URL || 'https://api.india.delta.exchange/v2';
const REFRESH_INTERVAL_MS = 15000;
const CANDLE_COUNT = 240;
const REQUIRED_TIMEFRAMES = ['15M', '1H', '4H'];
const TIMEFRAMES = {
  '1M': { resolution: '1m', seconds: 60 },
  '3M': { resolution: '3m', seconds: 180 },
  '5M': { resolution: '5m', seconds: 300 },
  '15M': { resolution: '15m', seconds: 900 },
  '30M': { resolution: '30m', seconds: 1800 },
  '1H': { resolution: '1h', seconds: 3600 },
  '2H': { resolution: '2h', seconds: 7200 },
  '4H': { resolution: '4h', seconds: 14400 },
  '6H': { resolution: '6h', seconds: 21600 },
  '12H': { resolution: '12h', seconds: 43200 },
  '1D': { resolution: '1d', seconds: 86400 },
};

export function normalizeSymbol(symbol) {
  let value = String(symbol || '').trim().toUpperCase().replace(/^DELTAIN:/, '').replace(/\.P$/, '');
  if (value.endsWith('USDT')) value = `${value.slice(0, -4)}USD`;
  if (!value.endsWith('USD')) value = `${value}USD`;
  return `${value}.P`;
}

export function timeframeToInterval(timeframe) {
  return TIMEFRAMES[String(timeframe || '').toUpperCase()]?.resolution || '15m';
}

function toDeltaSymbol(symbol) {
  return normalizeSymbol(symbol).replace(/\.P$/, '');
}

function mapCandle(candle, symbol, timeframe) {
  const frame = TIMEFRAMES[timeframe];
  const openTime = Number(candle.time) * 1000;
  const closeTime = openTime + frame.seconds * 1000;
  return {
    symbol,
    timeframe,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume || 0),
    openTime,
    closeTime,
    isClosed: closeTime <= Date.now(),
  };
}

export class DeltaIndiaProvider {
  constructor() {
    this.events = new EventEmitter();
    this.subscriptions = new Map();
    this.snapshots = new Map();
    this.popularSymbols = ['XRPUSD.P'];
  }

  async subscribe(symbol, timeframe = '15M') {
    const normalizedSymbol = normalizeSymbol(symbol);
    const marketSymbol = toDeltaSymbol(normalizedSymbol);
    if (!/^[A-Z0-9]{5,20}$/.test(marketSymbol)) {
      throw new Error(`Unsupported market symbol: ${symbol}`);
    }

    let subscription = this.subscriptions.get(normalizedSymbol);
    const isNew = !subscription;
    if (!subscription) {
      subscription = {
        marketSymbol,
        timeframes: new Set(),
        lastClosedByTimeframe: new Map(),
        timer: null,
      };
      this.subscriptions.set(normalizedSymbol, subscription);
    }
    for (const frame of [...REQUIRED_TIMEFRAMES, String(timeframe).toUpperCase()]) {
      if (TIMEFRAMES[frame]) subscription.timeframes.add(frame);
    }

    const available = await this.refresh(normalizedSymbol, { seed: isNew });
    if (!available) {
      if (isNew) this.subscriptions.delete(normalizedSymbol);
      throw new Error(`Live Delta Exchange India data is unavailable for ${normalizedSymbol}.`);
    }

    if (!subscription.timer) {
      subscription.timer = setInterval(() => {
        this.refresh(normalizedSymbol).catch((error) => {
          console.warn(`Delta market refresh error for ${normalizedSymbol}:`, error.message);
        });
      }, REFRESH_INTERVAL_MS);
    }
  }

  unsubscribe(symbol) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const subscription = this.subscriptions.get(normalizedSymbol);
    if (subscription?.timer) clearInterval(subscription.timer);
    this.subscriptions.delete(normalizedSymbol);
  }

  onTick(callback) {
    this.events.on('tick', callback);
  }

  onCandle(callback) {
    this.events.on('candle', callback);
  }

  onRefresh(callback) {
    this.events.on('refresh', callback);
  }

  async getCurrentPrice(symbol) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const snapshot = this.snapshots.get(normalizedSymbol);
    if (!snapshot || !snapshot.price) {
      await this.refresh(normalizedSymbol);
    }
    const fresh = this.snapshots.get(normalizedSymbol);
    if (!fresh || fresh.price == null) {
      throw new Error(`No live price is available for ${normalizedSymbol}.`);
    }
    return fresh.price;
  }

  getSnapshot(symbol) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const marketSymbol = toDeltaSymbol(normalizedSymbol);
    return (
      this.snapshots.get(normalizedSymbol) || {
        symbol: normalizedSymbol,
        marketSymbol,
        tradingViewSymbol: `DELTAIN:${normalizedSymbol}`,
        status: 'UNAVAILABLE',
        price: null,
        change24h: 0,
        high24h: null,
        low24h: null,
        volume24h: null,
        candles: [],
        candlesByTimeframe: {},
        updatedAt: null,
      }
    );
  }

  async getTopMarketOverview() {
    try {
      const response = await fetch(
        `${DELTA_API_BASE}/tickers?contract_types=perpetual_futures&underlying_asset_symbols=XRP`,
        { headers: { Accept: 'application/json', 'User-Agent': 'TraderAssist/1.0' } }
      );
      if (!response.ok) return [];
      const data = await response.json();
      const tickers = new Map((data.result || []).map((item) => [item.symbol, item]));
      return this.popularSymbols.flatMap((symbol) => {
        const ticker = tickers.get(toDeltaSymbol(symbol));
        if (!ticker) return [];
        return [{
          symbol,
          tradingViewSymbol: `DELTAIN:${symbol}`,
          price: Number(ticker.close),
          change24h: Number(ticker.ltp_change_24h),
          high24h: Number(ticker.high),
          low24h: Number(ticker.low),
          volume: Number(ticker.volume),
        }];
      });
    } catch {
      return [];
    }
  }

  async refresh(symbol, { seed = false } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const subscription = this.subscriptions.get(normalizedSymbol);
    const marketSymbol = subscription?.marketSymbol || toDeltaSymbol(normalizedSymbol);

    try {
      const tickerResponse = await fetch(`${DELTA_API_BASE}/tickers/${marketSymbol}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'TraderAssist/1.0' },
      });
      if (!tickerResponse.ok) throw new Error(`Delta rejected product ${marketSymbol}`);
      const tickerPayload = await tickerResponse.json();
      const ticker = tickerPayload.result;
      if (!tickerPayload.success || !ticker || !Number.isFinite(Number(ticker.close))) {
        throw new Error(`Delta returned no ticker for ${marketSymbol}`);
      }

      const frames = [...(subscription?.timeframes || new Set(REQUIRED_TIMEFRAMES))];
      const nowSeconds = Math.floor(Date.now() / 1000);
      const candlesByTimeframe = {};
      await Promise.all(frames.map(async (timeframe) => {
        const frame = TIMEFRAMES[timeframe];
        const query = new URLSearchParams({
          symbol: marketSymbol,
          resolution: frame.resolution,
          start: String(nowSeconds - frame.seconds * CANDLE_COUNT),
          end: String(nowSeconds),
        });
        const response = await fetch(`${DELTA_API_BASE}/history/candles?${query}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'TraderAssist/1.0' },
        });
        if (!response.ok) throw new Error(`Delta candles unavailable for ${marketSymbol} ${frame.resolution}`);
        const payload = await response.json();
        if (!payload.success || !Array.isArray(payload.result)) {
          throw new Error(`Delta returned invalid ${frame.resolution} candles for ${marketSymbol}`);
        }
        candlesByTimeframe[timeframe] = payload.result
          .map((candle) => {
            const openTime = Number(candle.time) * 1000;
            const closeTime = openTime + frame.seconds * 1000;
            return {
              symbol: normalizedSymbol,
              timeframe,
              open: Number(candle.open),
              high: Number(candle.high),
              low: Number(candle.low),
              close: Number(candle.close),
              volume: Number(candle.volume || 0),
              openTime,
              closeTime,
              isClosed: closeTime <= Date.now(),
            };
          })
          .sort((left, right) => left.openTime - right.openTime);
      }));

      const candles = candlesByTimeframe['15M'] || [];
      const snapshot = {
        symbol: normalizedSymbol,
        marketSymbol,
        tradingViewSymbol: `DELTAIN:${normalizedSymbol}`,
        status: 'LIVE',
        price: Number(ticker.close),
        change24h: Number(ticker.ltp_change_24h),
        high24h: Number(ticker.high),
        low24h: Number(ticker.low),
        volume24h: Number(ticker.volume),
        candles,
        candlesByTimeframe,
        updatedAt: Date.now(),
      };

      this.snapshots.set(normalizedSymbol, snapshot);

      this.events.emit('tick', {
        symbol: normalizedSymbol,
        price: snapshot.price,
        change24h: snapshot.change24h,
        high24h: snapshot.high24h,
        low24h: snapshot.low24h,
        volume: snapshot.volume24h,
        time: snapshot.updatedAt,
      });

      this.events.emit('refresh', { symbol: normalizedSymbol, snapshot });

      if (subscription) {
        for (const timeframe of frames) {
          const closedCandles = candlesByTimeframe[timeframe].filter((candle) => candle.isClosed);
          const latestClosed = closedCandles.at(-1);
          if (!latestClosed) continue;
          const previousCloseTime = subscription.lastClosedByTimeframe.get(timeframe);
          if (previousCloseTime == null || seed) {
            subscription.lastClosedByTimeframe.set(timeframe, latestClosed.closeTime);
            continue;
          }
          for (const candle of closedCandles.filter((item) => item.closeTime > previousCloseTime)) {
            this.events.emit('candle', candle);
            subscription.lastClosedByTimeframe.set(timeframe, candle.closeTime);
          }
        }
      }

      return true;
    } catch (error) {
      const previous = this.snapshots.get(normalizedSymbol);
      this.snapshots.set(normalizedSymbol, {
        ...(previous || { symbol: normalizedSymbol, price: null, candles: [], candlesByTimeframe: {} }),
        status: previous?.price ? 'LIVE' : 'UNAVAILABLE',
        error: error.message,
        updatedAt: Date.now(),
      });
      return Boolean(previous?.price);
    }
  }
}
