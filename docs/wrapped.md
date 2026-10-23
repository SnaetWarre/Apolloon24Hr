# Apolloon Wrapped

After the race, every runner who ran at least one lap gets four story images of their race (1080×1920, for Instagram) by e-mail. Runners with no laps get nothing.

Wrapped is not part of the event app. You run it once, at home, from your own laptop, on a backup of the race that someone takes at the event (step 1). The race laptops need nothing else, and nothing needs internet at the event.

## What is on the pages

The pages are a copy of the Canva design "24 urenloop WRAPPED" (October 2026). `/wrapped/card?runner=<id>` shows one runner's pages under each other (`src/components/wrapped/WrappedStory.tsx`, styles in `src/styles/wrapped.css`):

1. First and last name, aantal rondes, snelste ronde, gemiddelde tijd, looptype, and totale afstand (520 m per lap).
2. "<first name>, je liep" with the lap count, the share of runners who ran fewer laps ("meer dan 78% van alle lopers"), and the distance in meters.
3. The fastest lap: which of the runner's own laps it was, the time of day it ended, and its place among everyone's fastest lap ("#17 van Apolloon"). Runners without a lap time skip this page.
4. The looptype with one line about it, and a chart of the runner's laps per hour from the start of the race. The types are Sprinter (fastest lap in the fastest 10%), Kilometervreter (more laps than 90% of runners), Metronoom (at least 3 lap times within 4 seconds of each other), Nachtuil (most laps between 00:00 and 06:00), Vroege vogel (most laps between 06:00 and 10:00), and otherwise Teamspeler. The first one that fits wins. For Nachtuil and Vroege vogel the bars in those hours are orange.

The boxes, checkered flags and the car are the design's own drawings, taken from its PDF (`public/wrapped/page-1.svg` to `page-4.svg`). The component puts the text on top at the positions, sizes and angles from the PDF; a long name or number shrinks to stay in its box. The fonts are the design's: Bebas Neue, Racing Sans One, and the 2014 League Spartan Bold (the newer League Spartan has narrower figures). Canva uses its own slightly thinner cut of Bebas Neue that is not available elsewhere, so that text is a little bolder and about 2% wider than in Canva.

`src/lib/wrapped.ts` computes the numbers with the same rules as the rest of the app:

- Every lap counts as a lap. Lap times skip double presses, split halves and forgotten handoffs (`isMeasuredLap` and `hasPlausibleDuration`).
- Hours are Brussels hours.

## After the race

1. After the race is finished, someone at the event opens Beheer › Systeem & herstel on any race laptop, clicks "Nu backup maken" and then "Laatste backup downloaden". That saves one `apolloon-….sqlite` file in the laptop's Downloads folder. They put it on a USB stick or share it privately with whoever runs Wrapped, never as a public link: it holds everyone's form answers. You don't need to be at the event, and it can wait: every linked laptop keeps the race and its backups until someone clears the race, and clearing makes a backup first.
2. On your laptop, in this repository (once: `npm ci` and `npx playwright install chromium`):

   ```sh
   npm run wrapped:cards -- --db=/path/to/apolloon-….sqlite
   ```

   This builds the app, starts it on a copy of the backup, and saves every runner's pages as PNGs (`0012 - Jan Peeters 1.png` to `4.png`) in `~/Documents/Apolloon Wrapped <year>/`, together with `manifest.json` (who has which images and who got them by mail) and `mail.txt`. It takes about a minute for 100 runners. Add `--out=<folder>` for another folder and `--only=146,203` to make only those runners' pages, for example to check the design. It refuses a backup in which the race is not finished, unless you add `--force`.
3. Look at a few runners' pages. Edit `mail.txt`: the first line is the subject (`Onderwerp: …`), the rest is the greeting and message. The mail adds the Apolloon logo, the pages two by two, an "Open Instagram" button, and the sign-off.
4. See who gets a mail:

   ```sh
   npm run wrapped:mail
   ```

   This sends nothing. It lists who already got their Wrapped (with the address and time), who still gets a mail, who has no valid e-mail address (send those images yourself), who answered "Nee" to being contacted again (they get no mail), and runners who share an address. Run it again at any time to see the full list of who got one.
5. Make a Google app password for the sending Gmail account: Google account › Security › 2-Step Verification must be on, then App passwords. Send yourself a test mail, then everyone:

   ```sh
   npm run wrapped:mail -- --test --from=club@gmail.com
   npm run wrapped:mail -- --send --from=club@gmail.com
   ```

   It asks for the app password and never stores it (or set `WRAPPED_GMAIL_PASSWORD`). It sends one mail every 2 seconds and prints a line per mail with the runner and the address (`verstuurd 12/300  146 Jan Peeters → jan@…`, or `MISLUKT` with the reason), with the pages shown in the mail and attached once more so they save to a phone in one tap. After each mail it writes `sentAt` to `manifest.json`, so if it stops (no internet, wrong password, Gmail's limit of about 500 mails a day), running it again only sends to the people still left. Nobody gets two mails.

Nothing here costs money: Playwright makes the images and a normal Gmail account sends the mails.

## Tests

`tests/wrapped.test.ts` checks the numbers, places and runner types on a made-up race. `tests/wrapped-mail.test.ts` sends through a local fake SMTP server (`smtp-server`) and checks the attachments, the resume after a stop, the stop on a wrong password, and that the test mail marks nobody as mailed.
