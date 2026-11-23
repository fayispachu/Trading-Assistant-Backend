import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { sendTestEmail } from '../services/email.js';

export const emailRouter = Router();
emailRouter.use(authMiddleware);

/**
 * GET /api/email/config
 * Returns the current user's email notification preferences & masked config
 */
emailRouter.get('/config', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const cfg = user.emailConfig || {};
    const hasPass = Boolean(cfg.smtpPass || process.env.SMTP_PASS);

    return res.json({
      emailNotifications: user.emailNotifications !== false,
      alertEmail: user.alertEmail || user.email,
      provider: cfg.provider || 'gmail',
      smtpHost: cfg.smtpHost || process.env.SMTP_HOST || 'smtp.gmail.com',
      smtpPort: cfg.smtpPort || Number(process.env.SMTP_PORT) || 587,
      smtpUser: cfg.smtpUser || process.env.SMTP_USER || '',
      hasPassword: hasPass,
      fromEmail: cfg.fromEmail || '',
      systemDefaultAvailable: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
    });
  } catch (err) {
    console.error('Error fetching email config:', err);
    return res.status(500).json({ error: 'Failed to fetch email settings.' });
  }
});

/**
 * POST /api/email/config
 * Save user's email preferences
 */
emailRouter.post('/config', async (req, res) => {
  try {
    const {
      emailNotifications,
      alertEmail,
      provider,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      fromEmail,
    } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (typeof emailNotifications === 'boolean') {
      user.emailNotifications = emailNotifications;
    }
    if (alertEmail) {
      user.alertEmail = alertEmail.trim();
    }

    user.emailConfig = user.emailConfig || {};
    if (provider) user.emailConfig.provider = provider;
    if (smtpHost !== undefined) user.emailConfig.smtpHost = smtpHost.trim();
    if (smtpPort !== undefined) user.emailConfig.smtpPort = Number(smtpPort);
    if (smtpUser !== undefined) user.emailConfig.smtpUser = smtpUser.trim();
    if (smtpPass && smtpPass.trim()) user.emailConfig.smtpPass = smtpPass.trim();
    if (fromEmail !== undefined) user.emailConfig.fromEmail = fromEmail.trim();

    await user.save();

    return res.json({
      message: 'Email settings saved successfully.',
      emailNotifications: user.emailNotifications,
      alertEmail: user.alertEmail || user.email,
    });
  } catch (err) {
    console.error('Error saving email config:', err);
    return res.status(500).json({ error: 'Failed to save email settings.' });
  }
});

/**
 * POST /api/email/test
 * Send a test email to the user
 */
emailRouter.post('/test', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const recipient = req.body.alertEmail || user.alertEmail || user.email;
    const userConfig = {
      ...(user.emailConfig || {}),
      alertEmail: recipient,
      // If user supplied temporary test credentials in request body, use them
      ...(req.body.smtpUser ? { smtpUser: req.body.smtpUser } : {}),
      ...(req.body.smtpPass ? { smtpPass: req.body.smtpPass } : {}),
      ...(req.body.smtpHost ? { smtpHost: req.body.smtpHost } : {}),
      ...(req.body.smtpPort ? { smtpPort: req.body.smtpPort } : {}),
      ...(req.body.provider ? { provider: req.body.provider } : {}),
    };

    const result = await sendTestEmail({
      to: recipient,
      userConfig,
    });

    if (result.success) {
      return res.json({
        success: true,
        message: `Test email sent successfully to ${result.recipient}!`,
        previewUrl: result.previewUrl,
      });
    }

    return res.status(400).json({
      success: false,
      error: result.error || 'Failed to send test email. Please check your credentials.',
    });
  } catch (err) {
    console.error('Error in test email route:', err);
    return res.status(500).json({ error: err.message || 'Error sending test email.' });
  }
});
