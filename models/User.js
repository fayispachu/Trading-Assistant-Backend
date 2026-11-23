import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    emailNotifications: { type: Boolean, default: true },
    alertEmail: { type: String, lowercase: true },
    emailConfig: {
      provider: { type: String, default: 'gmail' },
      smtpHost: { type: String, default: '' },
      smtpPort: { type: Number, default: 587 },
      smtpUser: { type: String, default: '' },
      smtpPass: { type: String, default: '' },
      fromEmail: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

export const User = mongoose.models.User || model('User', userSchema);
