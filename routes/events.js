import { Router } from 'express';
import { AgentEvent } from '../models/index.js';
import { authMiddleware } from '../middleware/auth.js';

export const eventsRouter = Router();
eventsRouter.use(authMiddleware);

eventsRouter.get('/', async (req, res) => {
  try {
    const events = await AgentEvent.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(60);
    return res.json(events);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch agent events.' });
  }
});
