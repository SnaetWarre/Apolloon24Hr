# Apolloon Wrapped

After the race, every runner who ran at least one lap gets one image of their race (1080×1920, an Instagram story) by e-mail. Runners with no laps get nothing.

Wrapped is not part of the event app. You run it once, at home, from your own laptop, on a backup of the race. The race laptops need nothing.

## What is on a card

The card page is `/wrapped/card?runner=<id>` (`src/components/wrapped/WrappedCard.tsx`, styles in `src/styles/wrapped.css`). It shows the distance (one lap is 520 m), the lap count, the fastest and average lap, the place in laps, the runner's labels, and the four best "facts". The facts are short Dutch sentences such as "Je liep 4 rondes tussen middernacht en 6 uur".

`src/lib/wrapped.ts` computes the numbers and the facts with the same rules as the rest of the app:

- Every lap counts as a lap. Lap times skip double presses, split halves and forgotten handoffs (`isMeasuredLap` and `hasPlausibleDuration`).
- Points use `calculateLapPoints`. A label rank counts the labels a runner had when they ran each lap.
- Hours are Brussels hours.
- A guess from the form, such as "8" rondes or "1:25" per lap, only shows when it reads cleanly. "Zo veel mogelijk" leaves that fact out.

To change the design, change only `WrappedCard.tsx` and `wrapped.css`.

## After the race

1. On any race laptop, open Beheer › Systeem & herstel, click "Nu backup maken", and copy the newest `apolloon-….sqlite` from the app data folder's `backups/` to a USB stick. Take it after the race was finished.
2. On your laptop, in this repository (once: `npm ci` and `npx playwright install chromium`):

   ```sh
   npm run wrapped:cards -- --db=/path/to/apolloon-….sqlite
   ```

   This builds the app, starts it on a copy of the backup, and saves every card as a PNG in `~/Documents/Apolloon Wrapped <year>/`, together with `manifest.json` (who has which card and who got it by mail) and `mail.txt`. It takes about a minute for 100 runners. Add `--out=<folder>` for another folder and `--only=146,203` to make only those runners' cards, for example to check the design. It refuses a backup in which the race is not finished, unless you add `--force`.
3. Look at a few cards. Edit `mail.txt`: the first line is the subject (`Onderwerp: …`), the rest is the mail.
4. See who gets a mail:

   ```sh
   npm run wrapped:mail
   ```

   This sends nothing. It lists who has no valid e-mail address (send those cards yourself), who answered "Nee" to being contacted again (they get no mail), and runners who share an address.
5. Make a Google app password for the sending Gmail account: Google account › Security › 2-Step Verification must be on, then App passwords. Send yourself a test mail, then everyone:

   ```sh
   npm run wrapped:mail -- --test --from=club@gmail.com
   npm run wrapped:mail -- --send --from=club@gmail.com
   ```

   It asks for the app password and never stores it (or set `WRAPPED_GMAIL_PASSWORD`). It sends one mail every 2 seconds, with the card shown in the mail and attached once more so it saves to a phone in one tap. After each mail it writes `sentAt` to `manifest.json`, so if it stops (no internet, wrong password, Gmail's limit of about 500 mails a day), running it again only sends to the people still left. Nobody gets two mails.

Nothing here costs money: Playwright makes the images and a normal Gmail account sends the mails.

## Tests

`tests/wrapped.test.ts` checks the numbers and facts on a made-up race. `tests/wrapped-mail.test.ts` sends through a local fake SMTP server (`smtp-server`) and checks the attachment, the resume after a stop, the stop on a wrong password, and that the test mail marks nobody as mailed.
