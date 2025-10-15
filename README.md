Leuven 24h Runner Tracker

Kanban board app for tracking runners. Works over LAN so multiple laptops can connect.

Building the App

Windows:
```
npm install
npm run electron:build:win
```
The .exe installer will be in the `release` folder.

Linux:
```
npm install
npm run electron:build:linux
```
The AppImage will be in the `release` folder.

Running the App

1. Install and run the app on the host laptop
2. Set ADMIN_PASSWORD in .env file (located next to the app)
3. Allow firewall access when prompted
4. Other laptops connect to http://HOST_IP:5173

Find host IP:
- Windows: `ipconfig` in cmd
- Linux: `ip addr` in terminal

Notes
- Data is stored in `data/app.db`
- All devices must be on the same network

