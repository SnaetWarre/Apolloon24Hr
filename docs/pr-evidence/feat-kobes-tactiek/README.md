# Kobe's tactiek PR evidence

## Capture setup

- Base revision: `f4eb947`
- Feature revision: `dc444ec`
- Browser: headless Chromium
- Seed: the same local `live` development database with 35 completed laps
- Desktop navigation comparison: `/analysis`, 1440 x 900
- Mobile navigation comparison: `/analysis`, 390 x 844
- Tactics captures: `/tactics`, 1440 x 1000 and 390 x 844

## Navigation before and after

| Viewport | Before | After |
|---|---|---|
| Desktop | [navigation-before.png](navigation-before.png) | [navigation-after.png](navigation-after.png) |
| Mobile | [navigation-mobile-before.png](navigation-mobile-before.png) | [navigation-mobile-after.png](navigation-mobile-after.png) |

## New tactics workspace

- [Live race and target simulation](tactics-live-after.png)
- [Historical Apolloon and VTK comparison](tactics-historical-after.png)
- [Live race on mobile](tactics-live-mobile-after.png)

The captures use a clean browser profile. The tactics page therefore starts
from the bundled `Quivr 2025` reference with Apolloon's 1,095 laps and hourly
profile selected automatically.

## Electron bundle check

`npm run electron:build:linux` produced
`release/Leuven 24h Tracker-1.2.0.AppImage`. The packaged reference at
`release/linux-unpacked/resources/app.asar.unpacked/dist/reference/quivr-2025-lap-times.json`
matched the source file byte-for-byte. Both files had SHA-256
`6e84a9b01b1b21f5cdb9a8bb918b3383b547e1f63feebe3d895fbf3bffefcf53`.
