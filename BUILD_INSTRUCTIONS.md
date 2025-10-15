For Your Boss (Windows)

You need to build the .exe on a Windows machine:

1. Install Node.js from nodejs.org
2. Open PowerShell in this folder
3. Run: `npm install` then `npm run electron:build:win`
4. Send them the .exe file from the `release/` folder
5. They double-click the installer and it works

For Linux

The AppImage is already built in `release/` folder. Just run it.

What they do:

1. Double-click the app
2. Edit the .env file to set their admin password
3. Let Windows/Linux firewall through when prompted
4. Other laptops go to http://HOST_IP:5173
5. Done

