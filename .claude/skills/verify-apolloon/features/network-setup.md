# Beheer › Vast netwerkadres

Vast netwerkadres, at the top of Beheer › Systeem & herstel, pins the laptop's wired adapter to the address it has now, so the TVs and other laptops keep finding it all race. It keeps the network's own prefix length (a /16 school network stays /16) and shows it on the confirm button. After the event the fold-out `Na het evenement: adres weer automatisch maken` sets the adapter back to automatic.

## Sub-features

- `net-profile` reads the adapter, its address, prefix length and address source from `/api/net/profile` and shows them on the `Nu:` line.
- `net-make-static` sends the address, the prefix length the laptop has now (the profile's suggestion, else the adapter's, else 24) and the gateway to `/api/net/make-static`, after `Ja, maak <adres>/<prefix> nu vast`.
- `net-revert` sends `/api/net/revert-dhcp` after the event, with two confirmations.

## How to get to it (user POV)

- Beheer › Systeem & herstel: open `/admin?section=system`. The panel is the first card.

## Driving it with drive.mjs

Preconditions:

- Any scenario (`ready` is fine). Answer `/api/net/profile` with `page.route` to pick the network (platform, adapter, `prefixLength`, `suggestion`), since the machine's own network decides it otherwise.
- Abort every `/api/net/make-static` and `/api/net/revert-dhcp` request with `page.route` and read its body there. A real one opens an admin password prompt on the screen and changes the machine's network.

- **Open.** `await page.goto(run.url('/admin?section=system'))`. Heading `Vast netwerkadres` is visible.
- **Pin.** Click `Maak dit adres vast`, then `getByRole('button', { name: /^Ja, maak .* nu vast$/ })`. The button names the address and prefix, for example `Ja, maak 10.20.5.17/16 nu vast`; the aborted request body holds `{ ip, prefixLength, gateway }`.
- **No suggestion.** With `suggestion: null` the address box is empty; type it in `Vast adres voor deze laptop` before clicking.

## Gotchas

- Never let the request through on this machine, not even on a throwaway run: the server starts the elevated script for real.
- The server checks the request again (`validateStaticRequest`): prefix 8 to 30, not the network's first or last address, and a gateway inside the same network.
