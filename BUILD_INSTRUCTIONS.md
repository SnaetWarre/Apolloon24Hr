Building for Windows

You need a Windows machine:

1. Install Node.js from nodejs.org
2. Open PowerShell in this folder
3. Run: `npm install` then `npm run electron:build:win`
4. Installer will be in `release/` folder

Building for Linux

On Linux:
```
npm install
npm run electron:build:linux
```
AppImage will be in `release/` folder.

For End Users

1. Run the installer
2. Allow firewall when prompted
3. Other laptops connect to http://HOST_IP:5173

Default admin password: `apolloon2025`

