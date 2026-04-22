import bcrypt from 'bcryptjs';
import { getSetting, setSetting } from './db.mjs';

const PASSWORD_HASH_KEY = 'password_hash';

export async function ensurePasswordFromEnv() {
  const existing = getSetting(PASSWORD_HASH_KEY);
  if (existing) return; // already set
  const plain = process.env.ADMIN_PASSWORD || '';
  if (!plain) return; // skip if not provided yet
  const hash = await bcrypt.hash(plain, 10);
  setSetting(PASSWORD_HASH_KEY, hash);
}

export function authMiddleware(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

export function registerAuthRoutes(app) {
  app.post('/api/login', async (req, res) => {
    const { password } = req.body || {};
    const hash = getSetting(PASSWORD_HASH_KEY);
    if (!hash) return res.status(503).json({ error: 'password not configured' });
    const ok = typeof password === 'string' && (await bcrypt.compare(password, hash));
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    req.session.authenticated = true;
    return res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });
}


