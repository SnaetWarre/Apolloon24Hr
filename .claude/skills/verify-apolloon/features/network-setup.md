# Beheer › Vast netwerkadres

Vast netwerkadres, at the top of Beheer › Systeem & herstel, pins the laptop's wired adapter to the address it has now, so the TVs and other laptops keep finding it all race. It keeps the network's own prefix length (a /16 school network stays /16) and shows it on the confirm button. After the event the fold-out `Na het evenement: adres weer automatisch maken` sets the adapter back to automatic.

## Sub-features

- `net-profile` reads the adapter, its address, prefix length and address source from `/api/net/profile`. The `Nu:` line shows the address, adapter, address source and the address the screens connect to; the prefix length shows only on the confirm button.
- `net-make-static` sends the address, the prefix length the laptop has now (the profile's suggestion, else the adapter's, else 24) and the gateway to `/api/net/make-static`, after `Ja, maak <adres>/<prefix> nu vast`.
- `net-revert` sends `{ eventOver: true, confirmText: 'VOORBIJ' }` to `/api/net/revert-dhcp` after the event: a checkbox, the typed word `VOORBIJ`, and two buttons.

## How to get to it (user POV)

- Beheer › Systeem & herstel: open `/admin?section=system`. The panel is the first card.

## Driving it with drive.mjs

Preconditions:

- Any scenario (`ready` is fine). Answer `/api/net/profile` with `page.route` to pick the network, since the machine's own network decides it otherwise. This answer shows every control: `{ ok: true, profile: { platform: 'linux', windows: false, elevateMethod: 'pkexec', elevateHint: 'Linux vraagt om je wachtwoord', manager: null, adapters: [P], primary: P, apipa: false, suggestion: { ip: '10.20.5.17', prefixLength: 16, gateway: null }, eventUrl: 'http://10.20.5.17:5173', primaryWired: true, lastElevation: null } }` with `P = { name: 'enp3s0', address: '10.20.5.17', prefixLength: 16, dhcp: true, connection: 'Bekabeld' }`.
- Abort every `/api/net/make-static` and `/api/net/revert-dhcp` request with `page.route` and read its body there. A real one opens an admin password prompt on the screen and changes the machine's network.

- **Open.** `await page.goto(run.url('/admin?section=system'))`. Heading `Vast netwerkadres` is visible.
- **Pin.** Click `Maak dit adres vast`, then `getByRole('button', { name: /^Ja, maak .* nu vast$/ })`. The button names the address and prefix, for example `Ja, maak 10.20.5.17/16 nu vast`; the aborted request body holds `{ ip, prefixLength, gateway }`.
- **No suggestion.** With `suggestion: null` the address box is empty; type it in `Vast adres voor deze laptop` before clicking. The prefix then comes from `primary.prefixLength`, so the button still reads `Ja, maak 10.20.5.18/16 nu vast`.
- **Revert.** Click the summary `Na het evenement: adres weer automatisch maken`, check `Het evenement is helemaal voorbij (echt waar).`, fill `Typ VOORBIJ om te bewijzen dat je het meent` with `VOORBIJ`, click `Zet terug op automatisch`, then `Ja, zet terug op automatisch`. The aborted request body is `{ eventOver: true, confirmText: 'VOORBIJ' }`.
- Each aborted request leaves `Failed to fetch` in the panel. That comes from the abort, not the app.

## Gotchas

- Never let the request through on this machine, not even on a throwaway run: the server starts the elevated script for real.
- The server checks the request again (`validateStaticRequest`): prefix 8 to 30, not the network's first or last address, and a gateway inside the same network.
