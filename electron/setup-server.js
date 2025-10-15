import express from 'express';
import fs from 'fs';
import path from 'path';

export function createSetupServer(userDataPath) {
  const setupApp = express();
  setupApp.use(express.json());

  let setupServer;

  setupApp.post('/setup', (req, res) => {
    const { password } = req.body;
    
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    const envPath = path.join(userDataPath, '.env');
    const envContent = `PORT=5173
ADMIN_PASSWORD=${password}
SESSION_SECRET=${generateRandomString(32)}
`;

    try {
      fs.writeFileSync(envPath, envContent);
      console.log('Setup complete, .env saved to:', envPath);
      res.json({ success: true });
      
      setTimeout(() => {
        if (setupServer) setupServer.close();
      }, 500);
    } catch (err) {
      console.error('Failed to save .env:', err);
      res.status(500).json({ error: 'Failed to save configuration' });
    }
  });

  setupServer = setupApp.listen(31337, () => {
    console.log('Setup server listening on port 31337');
  });
  
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

