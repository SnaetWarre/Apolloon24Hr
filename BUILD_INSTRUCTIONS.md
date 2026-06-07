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
2. Allow firewall access for TCP port `5173`.
3. Copy the Event URL shown by the app on the host laptop.
4. Open that Event URL on every client laptop. Do not use `localhost` on client laptops.

No password is required. Client IP addresses can stay automatic.
