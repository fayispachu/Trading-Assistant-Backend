import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const agentEventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: 'User' },
    setupId: { type: Schema.Types.ObjectId, required: true, index: true, ref: 'Setup' },
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    symbol: { type: String, required: true },
    message: { type: String, required: true },
    stage: { type: String },
    occurredAt: { type: Date },
    price: { type: Number },
    direction: { type: String },
    setupName: { type: String },
    timeframe: { type: String },
    tradeEntryPrice: { type: Number },
    tradeStopLoss: { type: Number },
    tradeTakeProfit: { type: Number },
    tradeRiskReward: { type: String },
    tradeEntryStatus: { type: String, enum: ['READY', 'SKIPPED_PRICE_MOVED', 'SKIPPED_INVALID_SETUP'] },
    journalOutcome: { type: String, enum: ['OPEN', 'WIN', 'LOSS', 'BREAKEVEN'], default: null },
    journalResultR: { type: Number },
    tradeExitPrice: { type: Number },
    journalClosedAt: { type: Date },
    journalResultSource: { type: String, enum: ['AUTO'] },
    journalLastEvaluatedAt: { type: Number },
    journalLastPrice: { type: Number },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

agentEventSchema.index({ symbol: 1, type: 1, journalOutcome: 1 });

export const AgentEvent = mongoose.models.AgentEvent || model('AgentEvent', agentEventSchema);
