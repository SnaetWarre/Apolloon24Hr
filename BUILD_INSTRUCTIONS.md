# Build Instructions

## Windows Installer

Use a Windows machine:

```text
npm install
npm run electron:build:win
```

The installer will be written to `release/`.

## Linux AppImage

On Linux:

```text
npm install
npm run electron:build:linux
```

The AppImage will be written to `release/`.

## Event Setup

1. Install and run the app on the host laptop.
2. Set the host laptop Ethernet IP to `192.168.24.10`.
3. Allow firewall access for TCP port `5173`.
4. Open `http://192.168.24.10:5173` on every client laptop.

No password is required. Client IP addresses can stay automatic.
