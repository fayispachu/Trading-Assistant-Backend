import mongoose from 'mongoose';

const { Schema, model } = mongoose;

export const conditionSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    name: { type: String, required: true },
    timeframe: { type: String, default: '15M' },
    parameters: { type: Object, default: {} },
    order: { type: Number, default: 1 },
    required: { type: Boolean, default: true },
    status: { type: String, enum: ['PENDING', 'TRIGGERED', 'FAILED'], default: 'PENDING' },
    triggeredAt: { type: Date },
    triggeredPrice: { type: Number },
    message: { type: String, default: '' },
    canReset: { type: Boolean, default: false },
    resetRule: { type: String },
  },
  { _id: false }
);

const setupSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: 'User' },
    name: { type: String, required: true },
    symbol: { type: String, required: true, uppercase: true },
    assetClass: { type: String, default: 'Crypto' },
    direction: { type: String, enum: ['BUY', 'SELL', 'BOTH'], default: 'BUY' },
    primaryTimeframe: { type: String, default: '15M' },
    confirmationTimeframe: { type: String, default: '15M' },
    explanation: { type: String, default: '' },
    conditionMode: { type: String, enum: ['SEQUENTIAL', 'INDEPENDENT'], default: 'SEQUENTIAL' },
    conditions: [conditionSchema],
    strategyProgress: { type: Schema.Types.Mixed, default: null },
    strategyStartedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['MONITORING', 'PARTIALLY_CONFIRMED', 'CONFIRMED', 'PAUSED'],
      default: 'MONITORING',
    },
    entryRule: { type: String, default: '' },
    stopLossRule: { type: String, default: '' },
    takeProfitRule: { type: String, default: '' },
    riskReward: { type: String, default: '' },
    notifications: { type: Boolean, default: true },
    sound: { type: Boolean, default: true },
    telegram: { type: Boolean, default: false },
    sessionStart: { type: String },
    sessionEnd: { type: String },
    timezone: { type: String, default: 'Asia/Kolkata' },
  },
  { timestamps: true }
);

export const Setup = mongoose.models.Setup || model('Setup', setupSchema);
