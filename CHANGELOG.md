# Changelog

All notable changes to the Leuven 24h Runner Tracker will be documented in this file.

## [0.8.0] - 2026-06-06

### Added

- Root role picker so every laptop can open the displayed Event URL and choose its role
- Telsysteem 2 timing view with spacebar handoff and undo
- Inside and outside TV display routes
- Analysis dashboard with CSV/JSON exports
- Admin CSV import from Google Forms/Sheets exports
- Runner profiles with runner numbers, labels, targets, historical times, and notes
- Label management and seeded Apolloon event labels

### Changed

- The event setup now shows the detected host LAN URL instead of relying on a static host IP
- The runner database now separates runner profiles, labels, queue state, race state, and laps
- The queue view keeps the familiar three-column flow while timing uses an internal running state

### Removed

- Password login and session auth
- mDNS/hostname discovery dependency

## [0.7.1] - 2025-10-24

### Improvements

- Minor improvements and UI tweaks in the header and connection info modal
- Internal server adjustments and dependency lockfile update

## [0.7.0] - 2025-10-23

### Added

- **mDNS Service Discovery**: The system now broadcasts itself on the local network as `telsysteem2.local:5173`, eliminating the need to manually find the host IP address
- **Connection Info Modal**: New "Ander apparaat verbinden" button in the header displays easy-to-follow instructions for connecting additional devices
- **Improved UX**: Enter key now adds runners to the warming up queue directly from the name input field for faster data entry

### Fixed

- Network connectivity issues caused by DHCP IP address changes - the hostname `telsysteem2.local` now works regardless of IP changes
- Replaced deprecated `onKeyPress` React event handler with modern `onKeyDown` for better browser compatibility

### Changed

- Client devices can now connect using a stable hostname instead of IP addresses

## [0.6.0] - 2025-10-22

### Initial Release

- Kanban-style board for tracking runners through warming_up, waiting, and ran states
- Real-time synchronization across multiple devices via WebSocket
- Drag-and-drop interface for managing runner status
- Queue management with automatic ordering
- Timer tracking for how long runners have been in each state
- Search functionality to quickly find runners
- Keyboard shortcuts for faster operations
- Password-protected admin interface
- Electron desktop application for Windows and Linux
