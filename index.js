import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';

import { connectDB } from './config/db.js';
import { Setup } from './models/index.js';
import { DeltaIndiaProvider, normalizeSymbol } from './services/market.js';
import { StrategyEngine } from './services/engine.js';
import { authRouter } from './routes/auth.js';
import { createSetupsRouter } from './routes/setups.js';
import { createMarketRouter } from './routes/market.js';
import { eventsRouter } from './routes/events.js';

// Global resilience handlers for transient cloud database hiccups
process.on('unhandledRejection', (reason, promise) => {
  console.warn('Unhandled Rejection caught (recovering):', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.warn('Uncaught Exception caught (recovering):', err?.message || err);
});

const app = express();
const server = http.createServer(app);
const secret = process.env.AUTH_SECRET || 'development-only-change-me';
const port = Number(process.env.PORT || 3001);
const clientOrigin = process.env.CLIENT_ORIGIN || 'https://traderassistant.netlify.app';

const isAllowedOrigin = (origin) =>
  !origin ||
  origin === clientOrigin ||
  (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));

const corsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
};

const io = new Server(server, { cors: corsOptions });
const provider = new DeltaIndiaProvider();
const engine = new StrategyEngine(provider);

// Middlewares
app.use(cors(corsOptions));
app.use(express.json({ limit: '500kb' }));
app.use(cookieParser());

// Routes
app.use('/api/auth', authRouter);
app.use('/api/setups', createSetupsRouter(engine, provider));
app.use('/api/market', createMarketRouter(provider));
app.use('/api/events', eventsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Realtime Socket.IO Auth
io.use((socket, next) => {
  try {
    const rawCookie = socket.handshake.headers.cookie || '';
    const match = rawCookie.match(/session=([^;]+)/);
    const token =
      (match ? decodeURIComponent(match[1]) : null) ||
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;

    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, secret);
    socket.data.user = decoded;
    return next();
  } catch {
    return next();
  }
});

io.on('connection', (socket) => {
  if (socket.data.user?.id) {
    socket.join(`user:${socket.data.user.id}`);
  }

  socket.emit('welcome', {
    status: 'connected',
    message: 'Realtime Trader Assist agent link established.',
  });

  socket.on('subscribe:symbol', (symbol) => {
    if (symbol) {
      socket.join(`market:${symbol.toUpperCase()}`);
    }
  });

  socket.on('unsubscribe:symbol', (symbol) => {
    if (symbol) {
      socket.leave(`market:${symbol.toUpperCase()}`);
    }
  });
});

// Broadcast live price ticks from Binance provider
provider.onTick((tick) => {
  if (tick && tick.symbol) {
    io.to(`market:${tick.symbol.toUpperCase()}`).emit('market:tick', tick);
    io.emit('market:tick:global', tick);
  }
});

// Strategy engine update events
engine.onUpdate((payload) => {
  if (payload.userId) {
    io.to(`user:${payload.userId}`).emit('setup:update', payload);
    if (payload.event && payload.setup?.notifications !== false) {
      io.to(`user:${payload.userId}`).emit('notification', {
        message: payload.event.message,
        type: payload.event.type,
        symbol: payload.event.symbol,
        price: payload.event.price,
      });
    }
  }
});

async function startServer() {
  try {
    await connectDB();

    // Subscribe to existing active setups safely
    try {
      const activeSetups = await Setup.find({
        status: { $in: ['MONITORING', 'PARTIALLY_CONFIRMED', 'CONFIRMED'] },
      });

      for (const setup of activeSetups) {
        try {
          const canonicalSymbol = normalizeSymbol(setup.symbol);
          if (setup.symbol !== canonicalSymbol) {
            setup.symbol = canonicalSymbol;
          }
          if (!setup.strategyStartedAt) setup.strategyStartedAt = new Date();
          await setup.save();
          await provider.subscribe(canonicalSymbol, setup.primaryTimeframe);
          engine.seedFromSnapshot(canonicalSymbol, provider.getSnapshot(canonicalSymbol));
        } catch (error) {
          console.warn(`Initial feed subscription skipped for ${setup.symbol}:`, error.message);
        }
      }
    } catch (queryErr) {
      console.warn('Initial setup pre-load skipped (DB connecting):', queryErr.message);
    }

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} is in use.`);
      } else {
        console.error('Server error:', error.message);
      }
      process.exit(1);
    });

    server.listen(port, () => {
      console.log(`Trader Assist Backend listening on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exit(1);
  }
}

startServer();

export { app, server, io, provider, engine };
