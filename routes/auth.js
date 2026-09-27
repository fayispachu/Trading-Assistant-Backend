import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { User } from '../models/index.js';
import { setAuthCookie, authMiddleware } from '../middleware/auth.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many login attempts. Please try again later.' },
});

authRouter.use(authLimiter);

authRouter.post('/register', async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(2, 'Name must be at least 2 characters'),
      email: z.string().email('Please enter a valid email address'),
      password: z.string().min(6, 'Password must be at least 6 characters'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.issues[0]?.message || 'Provide a valid name, email, and password.';
      return res.status(400).json({ error: err });
    }

    const email = parsed.data.email.toLowerCase();
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const user = await User.create({
      name: parsed.data.name.trim(),
      email,
      passwordHash,
    });

    const token = setAuthCookie(res, String(user._id));
    return res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('Registration failed:', error);
    return res.status(500).json({ error: 'Account creation failed. Please try again.' });
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Enter a valid email and password.' });
    }

    const user = await User.findOne({ email: parsed.data.email.toLowerCase() });
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const token = setAuthCookie(res, String(user._id));
    return res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Authentication failed.' });
  }
});

authRouter.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  res.clearCookie('session', {
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
  });
  return res.sendStatus(204);
});

authRouter.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});
