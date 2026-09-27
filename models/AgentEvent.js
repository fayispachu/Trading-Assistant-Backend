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
    price: { type: Number },
    direction: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

export const AgentEvent = mongoose.models.AgentEvent || model('AgentEvent', agentEventSchema);
