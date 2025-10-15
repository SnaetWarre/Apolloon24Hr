import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createSetupServer() {
  const setupApp = express();
  setupApp.use(express.json());

  setupApp.post('/setup', (req, res) => {
    const { password } = req.body;
    
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    const envPath = path.join(app.getPath('userData'), '.env');
    const envContent = `PORT=5173
ADMIN_PASSWORD=${password}
SESSION_SECRET=${generateRandomString(32)}
`;

    try {
      fs.writeFileSync(envPath, envContent);
      res.json({ success: true });
      
      setTimeout(() => {
        setupServer.close();
      }, 500);
    } catch (err) {
      res.status(500).json({ error: 'Failed to save configuration' });
    }
  });

  const setupServer = setupApp.listen(31337);
  return setupServer;
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

