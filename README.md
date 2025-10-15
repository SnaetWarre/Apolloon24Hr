Leuven 24h Runner Tracker

Kanban board for tracking runners. Works over LAN so multiple laptops can connect.

Getting the App

Download from GitHub Actions or build yourself.

Building

Windows:
```
npm install
npm run electron:build:win
```

Linux:
```
npm install
npm run electron:build:linux
```

Installers will be in the `release` folder.

Using the App

1. Run the installer on the host laptop
2. Set admin password on first launch
3. Allow firewall when prompted
4. Other laptops connect to http://HOST_IP:5173

Find host IP:
- Windows: `ipconfig`
- Linux: `ip addr`

Notes
- Password and data stored in app data folder
- All devices must be on same network

