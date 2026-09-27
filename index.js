import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';

import { connectDB } from './config/db.js';
import { Setup } from './models/index.js';
import {
  DeltaIndiaProvider,
  normalizeSymbol,
} from './services/market.js';
import { StrategyEngine } from './services/engine.js';
import { authRouter } from './routes/auth.js';
import { createSetupsRouter } from './routes/setups.js';
import { createMarketRouter } from './routes/market.js';
import { eventsRouter } from './routes/events.js';

// ============================================================
// GLOBAL RESILIENCE HANDLERS
// ============================================================

// Global resilience handler for transient cloud database hiccups
process.on('unhandledRejection', (reason, promise) => {
  console.warn(
    'Unhandled Rejection caught (recovering):',
    reason?.message || reason
  );
});

process.on('uncaughtException', (err) => {
  console.warn(
    'Uncaught Exception caught (recovering):',
    err?.message || err
  );
});

// ============================================================
// APP SETUP
// ============================================================

const app = express();
const server = http.createServer(app);

const secret =
  process.env.AUTH_SECRET ||
  'development-only-change-me';

const port = Number(process.env.PORT || 3001);

// ============================================================
// CORS CONFIGURATION
// ============================================================

const clientOrigin =
  process.env.CLIENT_ORIGIN ||
  'https://traderassistant.netlify.app';

const allowedOrigins = [
  'https://traderassistant.netlify.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

// Check whether browser origin is allowed
const isAllowedOrigin = (origin) => {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (origin.endsWith('.netlify.app') || origin.endsWith('.vercel.app')) {
    return true;
  }

  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      console.warn(
        'CORS blocked origin:',
        origin
      );

      callback(
        new Error(
          `CORS blocked origin: ${origin}`
        )
      );
    }
  },

  credentials: true,

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
  ],

  optionsSuccessStatus: 204,
};

// ============================================================
// SOCKET.IO
// ============================================================

const io = new Server(server, {
  cors: corsOptions,
});

const provider = new DeltaIndiaProvider();
const engine = new StrategyEngine(provider);

// ============================================================
// MIDDLEWARES
// ============================================================

app.use(cors(corsOptions));

// Explicitly handle browser CORS preflight requests
app.options(/.*/, cors(corsOptions));

app.use(
  express.json({
    limit: '500kb',
  })
);

app.use(cookieParser());

// ============================================================
// ROUTES
// ============================================================

// Authentication
app.use('/api/auth', authRouter);

// Trading setups
app.use(
  '/api/setups',
  createSetupsRouter(
    engine,
    provider
  )
);

// Market data
app.use(
  '/api/market',
  createMarketRouter(provider)
);

// Events
app.use('/api/events', eventsRouter);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});

// ============================================================
// REALTIME SOCKET.IO AUTH
// ============================================================

io.use((socket, next) => {
  try {
    const rawCookie =
      socket.handshake.headers.cookie || '';

    const match =
      rawCookie.match(/session=([^;]+)/);

    const token =
      (match
        ? decodeURIComponent(match[1])
        : null) ||
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;

    // Socket can connect without authentication
    if (!token) {
      return next();
    }

    const decoded = jwt.verify(
      token,
      secret
    );

    socket.data.user = decoded;

    return next();
  } catch {
    return next();
  }
});

// ============================================================
// SOCKET.IO CONNECTION
// ============================================================

io.on('connection', (socket) => {
  // Join authenticated user's private room
  if (socket.data.user?.id) {
    socket.join(
      `user:${socket.data.user.id}`
    );
  }

  // Welcome event
  socket.emit('welcome', {
    status: 'connected',
    message:
      'Realtime Trader Assist agent link established.',
  });

  // Subscribe to symbol
  socket.on(
    'subscribe:symbol',
    (symbol) => {
      if (symbol) {
        socket.join(
          `market:${symbol.toUpperCase()}`
        );
      }
    }
  );

  // Unsubscribe from symbol
  socket.on(
    'unsubscribe:symbol',
    (symbol) => {
      if (symbol) {
        socket.leave(
          `market:${symbol.toUpperCase()}`
        );
      }
    }
  );
});

// ============================================================
// MARKET PRICE TICKS
// ============================================================

// Broadcast live price ticks from provider
provider.onTick((tick) => {
  if (tick && tick.symbol) {
    // Symbol-specific room
    io
      .to(
        `market:${tick.symbol.toUpperCase()}`
      )
      .emit(
        'market:tick',
        tick
      );

    // Global market tick
    io.emit(
      'market:tick:global',
      tick
    );
  }
});

// ============================================================
// STRATEGY ENGINE EVENTS
// ============================================================

engine.onUpdate((payload) => {
  if (payload.userId) {
    // Setup update
    io
      .to(
        `user:${payload.userId}`
      )
      .emit(
        'setup:update',
        payload
      );

    // Notification
    if (
      payload.event &&
      payload.setup?.notifications !== false
    ) {
      io
        .to(
          `user:${payload.userId}`
        )
        .emit(
          'notification',
          {
            message:
              payload.event.message,

            type:
              payload.event.type,

            symbol:
              payload.event.symbol,

            price:
              payload.event.price,
          }
        );
    }
  }
});

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  try {
    // Connect MongoDB
    await connectDB();

    // ========================================================
    // LOAD EXISTING ACTIVE SETUPS
    // ========================================================

    try {
      const activeSetups =
        await Setup.find({
          status: {
            $in: [
              'MONITORING',
              'PARTIALLY_CONFIRMED',
              'CONFIRMED',
            ],
          },
        });

      for (
        const setup of activeSetups
      ) {
        try {
          // Normalize symbol
          const canonicalSymbol =
            normalizeSymbol(
              setup.symbol
            );

          if (
            setup.symbol !==
            canonicalSymbol
          ) {
            setup.symbol =
              canonicalSymbol;
          }

          // Set strategy start time
          if (
            !setup.strategyStartedAt
          ) {
            setup.strategyStartedAt =
              new Date();
          }

          // Save updated setup
          await setup.save();

          // Subscribe to market provider
          await provider.subscribe(
            canonicalSymbol,
            setup.primaryTimeframe
          );

          // Seed strategy engine
          engine.seedFromSnapshot(
            canonicalSymbol,
            provider.getSnapshot(
              canonicalSymbol
            )
          );
        } catch (error) {
          console.warn(
            `Initial feed subscription skipped for ${setup.symbol}:`,
            error.message
          );
        }
      }
    } catch (queryErr) {
      console.warn(
        'Initial setup pre-load skipped (DB connecting):',
        queryErr.message
      );
    }

    // ========================================================
    // SERVER ERROR HANDLING
    // ========================================================

    server.on(
      'error',
      (error) => {
        if (
          error.code ===
          'EADDRINUSE'
        ) {
          console.error(
            `Port ${port} is in use.`
          );
        } else {
          console.error(
            'Server error:',
            error.message
          );
        }

        process.exit(1);
      }
    );

    // ========================================================
    // START HTTP SERVER
    // ========================================================

    server.listen(
      port,
      () => {
        console.log(
          `Trader Assist Backend listening on http://localhost:${port}`
        );

        console.log(
          'Allowed CORS origins:',
          allowedOrigins
        );
      }
    );
  } catch (error) {
    console.error(
      'Server startup failed:',
      error.message
    );

    process.exit(1);
  }
}

// ============================================================
// START APPLICATION
// ============================================================

startServer();

// ============================================================
// EXPORTS
// ============================================================

export {
  app,
  server,
  io,
  provider,
  engine,
};