# Changelog

All notable changes to the Leuven 24h Runner Tracker will be documented in this file.

## [Unreleased]

Vereist een nieuwe major versie: laptops met deze versie koppelen niet met 3.x.
De database migreert automatisch naar schema 13 en bewaart eerst een kopie
(`app.pre-schema-13.sqlite`).

### Changed

- Eén primaire laptop doet alle wijzigingen; een standby-laptop volgt live en
  alleen-lezen. Dit vervangt de synchronisatie waarbij elke laptop schreef:
  geen syncconflicten, quarantaine, timingcontroller of koppelcode meer.
  Overnemen kan gepland (zonder verlies) of als noodovername
- Tijdelijke nachtploegen volgen hun planning zonder labels te herschrijven:
  leden kunnen altijd aangepast worden en zitten na afloop meteen terug in hun
  eigen speedteam
- Contactgegevens uit de inschrijving zitten niet meer in de live data die elk
  scherm (ook de tv's) laadt; alleen profielen en Beheer halen ze op
- Schermen halen na elke wijziging de actuele staat op in plaats van losse
  updates samen te voegen, zodat een scherm nooit op een oude staat blijft staan
- Backups worden in een aparte thread gecontroleerd en eenvoudiger bewaard (48
  geplande en 20 overige); database verkleinen, controlebestanden en de
  dagelijkse/uurlijkse bewaring zijn weg
- Beheer is opgesplitst per onderdeel
- Vast netwerkadres en de scripts openen alleen nog TCP 5173: UDP 45737 was
  voor de automatische laptopdetectie, die niet meer bestaat
- Code wordt gecontroleerd met oxlint en opgemaakt met oxfmt; de
  browsercontroles draaien in CI

- Bevestigingen zijn in-app dialogen i.p.v. browserpop-ups: de live klokken en
  realtime updates lopen door terwijl een vraag openstaat, en de knoppen zeggen
  wat ze doen ("Timing overnemen", "Definitief verwijderen", ...)

### Fixed

- Spatie of Enter in een open dialoog op het timingscherm registreert geen
  wissel meer
- De Electron-app herstart de server automatisch als die onverwacht stopt
- De klok op het timingscherm verspringt niet meer na het herladen van de
  live data

## [3.1.0] - 2026-09-22

Race-hardening bovenop 3.0.0. Ook deze versie synchroniseert alleen met gelijke
versies: alle evenement-laptops moeten 3.1.0 draaien.

### Fixed

- Foute synchronisatie-acties gaan in quarantaine i.p.v. de hele sync stil te
  leggen, met een teller en waarschuwing in Admin
- Statuswijzigingen die de live race raken kunnen alleen nog vanaf de
  timinglaptop; wachtrijwerk op Telsysteem 1 is ongewijzigd
- Schermen halen na een onderbreking alles opnieuw op bij reconnect, met een
  offline-banner en echte revisienummers

## [3.0.0] - 2026-09-22

Event-ready major release. Alle laptops op het evenement moeten deze versie draaien:
3.x weigert te synchroniseren met 2.x, zodat er nooit per ongeluk gemengde versies meedoen.

### Added

- Noob-vriendelijk "Vast netwerkadres"-paneel in Admin: pin het huidige adres als vast IP
  met één knop op Windows, Linux (NetworkManager) en macOS, inclusief dubbel-bevestigde
  VOORBIJ-terugzet naar DHCP na het evenement
- Gebundelde netwerkscripts (PowerShell en shell) die de app zelf serveert, ook zonder source
  code op de laptop
- Clusterherstel bij IP-wissels van laptops, timing- en wachtrijbeveiligingen, en
  herstelmetingen als regressiebewijs

### Changed

- Operatorinterface heringericht rond wachtrijlijsten en een aparte timingpost, met
  toetsenbordveilige dialogen en een rustiger donker thema
- Verplichte CI (typecheck, unit-, e2e- en packaging-tests) en geharde releases met
  rooktests per platform

## [2.0.0] - 2026-09-03

### Added

- Kobe's Tactiek workspace with live drafting guidance, race analysis, tempo scenarios, diagnostics, and historical deep dives
- Inside-display rankings for lap performance and coefficient totals, alongside recent-runner context

### Changed

- Redesign the operator interface around a coherent Apolloon blue palette, compact navigation, clear page hierarchy, consistent cards and controls, accessible focus states, and responsive layouts
- Refresh the home, queue, timing, analysis, and public displays with clearer hierarchy and calmer motion

### Fixed

- Keep admin panels, import controls, and label actions aligned across wide, zoomed, laptop, tablet, and mobile layouts
- Keep Kanban cards directly under the pointer while dragging instead of animating behind it
- Clarify reusable SQLite space, flatten nested admin controls, contain long analysis values, and keep public displays free of operator buttons

## [1.2.0] - 2026-08-08

### Added

- Local-first synchronization between writable Electron laptops, including authenticated discovery, reconnect catch-up, compatibility checks, and explicit timing transfer
- Verified automatic and manual SQLite backups with retention, download manifests, storage monitoring, and guarded compaction
- Event-readiness status for backups, replicas, clock skew, timing ownership, and synchronization conflicts
- Temporary night teams that safely replace and restore each runner's normal speedteam
- Realtime Burgie and record alerts on the outside display

### Changed

- Live state and historical race data now load separately for faster initial rendering and smaller ordinary updates
- Analysis, administration, and display code now loads per role and preloads on user intent, reducing startup work on operator laptops
- The packaged backend now shuts down cleanly with Electron and reports release, database, and backup health
- The bundled CSV is now a usable import example with the documented columns and duration format

### Fixed

- Keep both outside-display panels within a single TV viewport without scrolling
- Do not replay historical Burgie or record alerts when the outside display first loads

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
