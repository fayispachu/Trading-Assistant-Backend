import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trading-agent';
  
  mongoose.connection.on('connected', () => {
    console.log('MongoDB connected successfully.');
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected. Reconnecting in background...');
  });

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message);
  });

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 30000,
      heartbeatFrequencyMS: 10000,
    });
  } catch (error) {
    console.error('Initial MongoDB connection error:', error.message);
    // Don't crash immediately; let connection listeners attempt recovery
  }
}
