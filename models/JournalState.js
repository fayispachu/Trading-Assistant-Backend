import mongoose from 'mongoose';

const journalStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    startedAt: { type: Date, required: true },
  },
  { versionKey: false }
);

const JournalState = mongoose.models.JournalState || mongoose.model('JournalState', journalStateSchema);

export async function getJournalStartAt() {
  const state = await JournalState.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: { startedAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return state.startedAt;
}
