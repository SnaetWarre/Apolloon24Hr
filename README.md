# Leuven 24h Runner Tracker

A digital board for tracking runners during the Leuven 24h event. Multiple laptops can connect and work together over your local network.

## Download & Installation

Download the latest version here:
https://github.com/SnaetWarre/Appoloon24Hr/releases/download/v0.5.0/Leuven-24h-Tracker-Setup-0.1.0.exe

## Setup Instructions

1. Download and run the installer on the main laptop (this will be the host)
2. Windows will show a security warning since this is an unofficial app. Click "More info" and then "Run anyway" to continue
3. If you don't see the login screen after installation, close and reopen the app by pressing your windows button to open the search menu and typing in "Leuven 24h tracker"
4. When Windows Firewall asks for permission, click "Allow" or "Yes" (this is needed for other laptops to connect)
5. On other laptops, open a web browser and go to: http://HOST_IP:5173 (replace HOST_IP with the host laptop's IP address)

Default admin login: `apolloon2025`

### Finding the Host IP Address
On the host laptop, open Command Prompt and:
- For Windows: Type `ipconfig` and look for "IPv4 Address"
- For Linux: Type `ip addr` and look for "inet"

## Important Notes
- Your login and tracking data are safely stored on your computer
- All laptops must be connected to the same WiFi/network to work together

