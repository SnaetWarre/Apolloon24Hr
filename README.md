# Leuven 24h Runner Tracker

A digital board for tracking runners during the Leuven 24h event. Multiple laptops can connect and work together over your local network.

## Download & Installation

Download the latest version here:
https://github.com/SnaetWarre/Apolloon24Hr/releases/download/v0.7.0/Leuven-24h-Tracker-Setup-0.7.0.exe

## Setup Instructions

1. Download and run the installer on the main laptop (this will be the host)
2. Windows will show a security warning since this is an unofficial app. Click "More info" and then "Run anyway" to continue
3. If you don't see the login screen after installation, close and reopen the app by pressing your windows button to open the search menu and typing in "Leuven 24h tracker"
4. When Windows Firewall asks for permission, click "Allow" or "Yes" (this is needed for other laptops to connect)
5. On the host laptop, click the "📱 Ander apparaat verbinden" button to see connection instructions

Default admin login: `apolloon2025`

## Connecting Additional Devices

**NEW in v0.7.0**: No more IP address hunting!

On any additional laptop or tablet connected to the same network, simply open a web browser and go to:

```
http://telsysteem2.local:5173
```

The system now uses mDNS service discovery, which means the hostname `telsysteem2.local` will automatically resolve to the correct IP address - even if the host laptop's IP changes due to DHCP!

### Troubleshooting Connection Issues

If `telsysteem2.local` doesn't work on some devices:
1. Make sure both devices are on the same local network/router
2. On the host laptop, click "📱 Ander apparaat verbinden" to see the connection URL
3. As a fallback, you can still use the IP address method:
   - On Windows: Open Command Prompt and type `ipconfig` (look for "IPv4 Address")
   - On Linux: Open terminal and type `ip addr` (look for "inet")
   - Then connect to: `http://[IP_ADDRESS]:5173`

## Important Notes
- Your login and tracking data are safely stored on your computer
- All laptops must be connected to the same WiFi/network to work together
- Press Enter after typing a runner's name to quickly add them to the warming up queue

