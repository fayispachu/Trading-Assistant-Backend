import jwt from 'jsonwebtoken';

const secret = process.env.AUTH_SECRET || 'development-only-change-me';

export const setAuthCookie = (res, id) => {
  const token = jwt.sign({ id }, secret, { expiresIn: '7d' });
  const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return token;
};

export const authMiddleware = (req, res, next) => {
  try {
    const token =
      req.cookies?.session ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({ error: 'Please sign in.' });
    }

    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Your session has expired.' });
  }
};
