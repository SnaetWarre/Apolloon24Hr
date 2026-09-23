# Dagdeelpunten voor de binnenschermranglijst

## Bron en keuze

De formules en voorbeelden zijn gecontroleerd in `coeff_berekeningen.xlsx` uit de aangeleverde Downloads-map. Het blad `Instellingen` gebruikt 85 seconden, factor 0,075 en dagdeelfactoren 1 / 1,25 / 1,5 / 1,5 / 1,25 / 1. De bladen `Rondelog` en `Berekeningen per loper` geven rondes boven 85 seconden een tijdscoëfficiënt van 1.

Per afgeronde ronde: `(1 + 0,075 × max(0, 85 − rondetijd in seconden)) × dagdeelfactor`. Het tijdvak volgt de geregistreerde aankomsttijd in `Europe/Brussels`. De grenzen zijn inclusief aan het begin van elk blok.

| Tijdvak | Factor |
|---|---:|
| 20:00–00:00 | 1 |
| 00:00–04:00 | 1,25 |
| 04:00–08:00 | 1,5 |
| 08:00–12:00 | 1,5 |
| 12:00–16:00 | 1,25 |
| 16:00–20:00 | 1 |

De test vergelijkt de voorbeeldtotalen uit het werkboek: Jan 3,09375, Marie 5,84375 en Pol 1,375. De overige tests dekken alle tijdvakgrenzen en de omschakeling naar wintertijd.

## Validatie

- Basis: `dcc62ec`; wijziging: `10feb8d`.
- `npm test`: 82 tests geslaagd vóór de extra werkboekvergelijking; de gerichte test daarna: 33 geslaagd.
- `npm run check`: geslaagd.
- `npm run test:e2e`: 23 tests geslaagd.
- `git diff --check`: geslaagd.
- Browser op `/display/inside`, 1280 × 800, `ready` fixture: de nieuwe knoptekst en toelichting zijn in de DOM gecontroleerd. Automatische screenshotcaptatie faalde; een losse headless Firefox-captatie toonde alleen het laadscherm en is daarom niet als beeldbewijs opgenomen.

De wijziging raakt alleen de berekende puntenranglijst op het binnenscherm. Historische rondes krijgen bij het openen van het scherm automatisch hun nieuwe score; er is geen databasemigratie.
