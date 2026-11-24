import nodemailer from 'nodemailer';
import { User } from '../models/User.js';

let cachedTransporter = null;
let etherealAccount = null;

/**
 * Build a nodemailer transporter based on user or environment settings.
 */
async function getTransporter(userConfig = {}) {
  // 1. If custom SMTP or Gmail is configured in user settings or environment variables
  const host = userConfig.smtpHost || process.env.SMTP_HOST;
  const port = Number(userConfig.smtpPort || process.env.SMTP_PORT || 587);
  const user = userConfig.smtpUser || process.env.SMTP_USER;
  const pass = userConfig.smtpPass || process.env.SMTP_PASS;

  if (user && pass) {
    // If it's a gmail address or userConfig.provider === 'gmail'
    if (userConfig.provider === 'gmail' || (user && user.includes('@gmail.com'))) {
      return nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user,
          pass, // Gmail App Password (16 chars)
        },
      });
    }

    return nodemailer.createTransport({
      host: host || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  // 2. If no credentials configured, create/use free Ethereal test inbox for instant zero-config testing
  if (!etherealAccount) {
    try {
      etherealAccount = await nodemailer.createTestAccount();
      console.log('Created free Ethereal email test account:', etherealAccount.user);
    } catch (e) {
      console.warn('Could not create Ethereal test account:', e.message);
    }
  }

  if (etherealAccount) {
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: etherealAccount.user,
        pass: etherealAccount.pass,
      },
    });
  }

  return null;
}

/**
 * Send Trade Setup Confirmation Email
 */
export async function sendSetupConfirmationEmail({
  to,
  setup,
  event,
  targets,
  userConfig = {},
}) {
  try {
    const transporter = await getTransporter(userConfig);
    if (!transporter) {
      console.warn('Email service: No transporter available.');
      return { success: false, error: 'Email service is not configured.' };
    }

    const recipient = to || userConfig.alertEmail || process.env.ALERT_EMAIL;
    if (!recipient) {
      console.warn('Email service: No recipient specified.');
      return { success: false, error: 'No recipient email specified.' };
    }

    const symbol = setup?.symbol || 'NQ / NASDAQ';
    const direction = event?.direction || setup?.direction || 'BUY';
    const setupName = setup?.name || `${symbol} Confirmation Strategy`;
    const isBuy = direction.toUpperCase() === 'BUY';
    const dirColor = isBuy ? '#10b981' : '#ef4444';
    const dirLabel = isBuy ? '▲ BUY (LONG)' : '▼ SELL (SHORT)';

    const entryPrice = event?.price || targets?.entryPrice || 'Market Close';
    const stopLoss = targets?.stopLoss || 'Box Invalidation';
    const takeProfit = targets?.takeProfit || '2R Target';
    const rr = setup?.riskReward || '1:2';
    const istTime = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const isNasdaq = symbol.includes('NDX') || symbol.includes('US100') || symbol.includes('NAS') || symbol.includes('NQ');

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Trade Confirmation Alert</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; color: #f1f5f9; margin: 0; padding: 20px; }
    .card { max-width: 600px; margin: 0 auto; background: #131926; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .header { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); padding: 24px; border-bottom: 1px solid #334155; }
    .badge { display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 700; border-radius: 6px; letter-spacing: 0.05em; text-transform: uppercase; background: rgba(59, 130, 246, 0.2); color: #60a5fa; margin-bottom: 8px; }
    .title { font-size: 20px; font-weight: 800; color: #ffffff; margin: 0 0 4px 0; }
    .subtitle { font-size: 13px; color: #94a3b8; margin: 0; }
    .body { padding: 24px; }
    .status-banner { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; }
    .status-left { font-weight: 700; font-size: 15px; color: #10b981; }
    .signal-pill { background: ${dirColor}; color: #ffffff; font-weight: 800; font-size: 14px; padding: 6px 14px; border-radius: 6px; display: inline-block; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .stat-box { background: #182234; border: 1px solid #233149; border-radius: 8px; padding: 12px 16px; }
    .stat-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
    .stat-value { font-size: 18px; font-weight: 800; color: #f8fafc; font-family: monospace; }
    .sl { color: #f87171 !important; }
    .tp { color: #4ade80 !important; }
    .rules-list { background: #182234; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
    .rules-title { font-size: 12px; font-weight: 700; color: #cbd5e1; text-transform: uppercase; margin-bottom: 10px; }
    .rule-row { display: flex; align-items: center; font-size: 13px; color: #94a3b8; margin-bottom: 8px; }
    .rule-icon { color: #10b981; margin-right: 8px; font-weight: bold; }
    .footer { padding: 16px 24px; background: #0c101a; border-top: 1px solid #1e293b; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="badge">${isNasdaq ? 'NASDAQ INDEX CFD • NQ BULLET' : 'CRYPTO AGENT • DELTA INDIA'}</div>
      <h1 class="title">${setupName}</h1>
      <p class="subtitle">Realtime automated validation confirmation at ${istTime} IST</p>
    </div>
    <div class="body">
      <div class="status-banner">
        <span class="status-left">✓ ALL CONFIRMATIONS MET</span>
        <span class="signal-pill">${dirLabel}</span>
      </div>

      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Trading Instrument</div>
          <div class="stat-value">${symbol}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Entry Price</div>
          <div class="stat-value">${entryPrice}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Stop Loss</div>
          <div class="stat-value sl">${stopLoss}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Take Profit (${rr} R:R)</div>
          <div class="stat-value tp">${takeProfit}</div>
        </div>
      </div>

      <div class="rules-list">
        <div class="rules-title">Confirmed Sequence Highlights</div>
        <div class="rule-row"><span class="rule-icon">✓</span> ${isNasdaq ? '10:30 - 10:45 IST Box High / Low Established & Ready' : '15M Swing Structure Confirmed'}</div>
        <div class="rule-row"><span class="rule-icon">✓</span> ${isNasdaq ? 'Trading Window (10:45 - 15:15 IST) Active' : '15M Candle Body-Close Break Beyond Swing Level'}</div>
        <div class="rule-row"><span class="rule-icon">✓</span> ${isNasdaq ? '50 EMA Trend Filter Aligned (' + (isBuy ? 'Uptrend' : 'Downtrend') + ')' : 'Minimum 2 Completed 15M Directional Confirmation Candles'}</div>
        <div class="rule-row"><span class="rule-icon">✓</span> ${isNasdaq ? 'Breakout & Zone Retest Confirmed' : 'Execution Area Retest Validated'}</div>
        <div class="rule-row"><span class="rule-icon">✓</span> ${isNasdaq ? '1H Major Swing Pivot Confluence Verified' : '1H & 4H Trend Bias Context Aligned'}</div>
      </div>

      <p style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin: 0;">
        <strong>Notice:</strong> This automated email was triggered because every required confirmation in your strategy was strictly validated. Ensure proper position sizing and risk management.
      </p>
    </div>
    <div class="footer">
      Trader Assist Automated Execution Agent • Realtime Strategy Alerts
    </div>
  </div>
</body>
</html>
    `;

    const fromAddress = userConfig.fromEmail || userConfig.smtpUser || process.env.SMTP_USER || '"Trader Assist" <alerts@traderassist.internal>';

    const info = await transporter.sendMail({
      from: fromAddress,
      to: recipient,
      subject: `🎯 [TRADE ALERT] ${dirLabel} Confirmed on ${symbol}!`,
      html: htmlContent,
    });

    let previewUrl = null;
    if (etherealAccount && info.messageId) {
      previewUrl = nodemailer.getTestMessageUrl(info);
      console.log('Ethereal test email preview URL:', previewUrl);
    }

    return {
      success: true,
      messageId: info.messageId,
      previewUrl,
      recipient,
    };
  } catch (err) {
    console.error('Failed to send setup confirmation email:', err);
    return { success: false, error: err.message };
  }
}

export async function sendSetupMilestoneEmail({ to, setup, event, userConfig = {} }) {
  try {
    const transporter = await getTransporter(userConfig);
    if (!transporter) {
      return { success: false, error: 'Email service is not configured.' };
    }

    const recipient = to || userConfig.alertEmail || process.env.ALERT_EMAIL;
    if (!recipient) {
      return { success: false, error: 'No recipient email specified.' };
    }

    const symbol = setup?.symbol || 'Market';
    const stageLabel = event?.stage === 'CHOCH'
      ? '15-minute CHOCH detected'
      : 'First confirmation candle completed';
    const fromAddress = userConfig.fromEmail || userConfig.smtpUser || process.env.SMTP_USER || '"Trader Assist" <alerts@traderassist.internal>';
    const info = await transporter.sendMail({
      from: fromAddress,
      to: recipient,
      subject: `Trader Assist update: ${stageLabel} on ${symbol}`,
      text: [
        `Setup: ${setup?.name || symbol}`,
        `Symbol: ${symbol}`,
        `Direction: ${event?.direction || setup?.direction || 'BOTH'}`,
        `Timeframe: ${event?.timeframe || '15M'}`,
        `Update: ${event?.message || stageLabel}`,
        'This is a setup progress update, not an instruction to trade.',
      ].join('\n'),
    });

    return {
      success: true,
      messageId: info.messageId,
      previewUrl: etherealAccount && info.messageId ? nodemailer.getTestMessageUrl(info) : null,
      recipient,
    };
  } catch (err) {
    console.error('Failed to send setup milestone email:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Send a Test Email to verify user configuration
 */
export async function sendTestEmail({ to, userConfig = {} }) {
  try {
    const transporter = await getTransporter(userConfig);
    if (!transporter) {
      return { success: false, error: 'Email service could not be initialized.' };
    }

    const recipient = to || userConfig.alertEmail || process.env.ALERT_EMAIL;
    if (!recipient) {
      return { success: false, error: 'Please enter a valid recipient email address.' };
    }

    const fromAddress = userConfig.fromEmail || userConfig.smtpUser || process.env.SMTP_USER || '"Trader Assist" <alerts@traderassist.internal>';

    const info = await transporter.sendMail({
      from: fromAddress,
      to: recipient,
      subject: '✅ Trader Assist: Email Notification Test Successful',
      html: `
        <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 8px; max-width: 500px;">
          <h2 style="color: #10b981; margin-top: 0;">✓ Email Notifications Active!</h2>
          <p style="color: #cbd5e1; font-size: 14px;">Your email setup is working. You will receive setup emails when a 15M CHOCH, a confirmation candle, or full confirmation is recorded. Opposing CHOCH observations are listed in the app only.</p>
          <div style="background: #1e293b; padding: 12px; border-radius: 6px; font-size: 13px; color: #94a3b8;">
            <div><strong>Recipient:</strong> ${recipient}</div>
            <div><strong>Timestamp:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
            <div><strong>Status:</strong> Ready for Live Strategy Signals</div>
          </div>
        </div>
      `,
    });

    let previewUrl = null;
    if (etherealAccount && info.messageId) {
      previewUrl = nodemailer.getTestMessageUrl(info);
    }

    return {
      success: true,
      messageId: info.messageId,
      previewUrl,
      recipient,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
