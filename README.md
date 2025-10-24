# Leuven 24h Runner Tracker

A digital board for tracking runners during the Leuven 24h event. Multiple laptops can connect and work together over your local network.

## Download & Installation

Download the latest version here:
https://github.com/SnaetWarre/Apolloon24Hr/releases/download/v0.7.1/Leuven-24h-Tracker-Setup-0.7.1.exe

## Setup Instructions

1. Download and run the installer on the main laptop (this will be the host)
2. Windows will show a security warning since this is an unofficial app. Click "More info" and then "Run anyway" to continue
3. If you don't see the login screen after installation, close and reopen the app by pressing your windows button to open the search menu and typing in "Leuven 24h tracker"
4. When Windows Firewall asks for permission, click "Allow" or "Yes" (this is needed for other laptops to connect)
5. In the app UI, you will see the connection address displayed (for example: `http://192.168.x.x:5173`). Use this address on other devices.

Default admin login: `apolloon2025`

## Connecting Additional Devices

Connect using the IP address shown in the app.

1. On the host laptop (the one running the desktop app), look at the connection address shown directly in the app UI. It will look like this:

   ```text
   http://192.168.1.23:5173
   ```

2. On any other laptop or tablet on the same network, open a web browser and enter that URL.

Notes:

- The IP can change when your network changes (e.g., different Wi‑Fi or after reboot). Check the app UI again to get the latest address.
- When Windows Firewall prompts, allow access so other devices can connect.

### Troubleshooting Connection Issues

1. Ensure the host and the other device are on the same local network/router.
2. Always use the URL shown directly in the app UI.
3. Verify the host app is open and the URL shows port 5173.
4. If connection fails, temporarily disable VPNs on both devices and try again.
5. As a fallback to find the IP manually:
   - On Windows: Open Command Prompt and run `ipconfig` (look for "IPv4 Address")
   - On Linux: Open terminal and run `ip addr` (look for "inet" on your active interface)
   - Then connect to: `http://[IP_ADDRESS]:5173`

## Important Notes

- Your login and tracking data are safely stored on your computer
- All laptops must be connected to the same WiFi/network to work together
- Press Enter after typing a runner's name to quickly add them to the warming up queue

