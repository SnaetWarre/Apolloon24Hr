# Changelog

All notable changes to Apolloon Telsysteem will be documented in this file.

## [Unreleased]

## [5.3.0] - 2026-10-22

Laptops koppelen alleen met dezelfde versie: zet 5.3.0 op alle laptops.

### Added

- Timing staat op één laptop tegelijk open. Op een andere laptop staat
  "Timing staat open op LAPTOP-A" met de knop Overnemen, voor als die laptop
  niet meer werkt. Zo telt geen ronde dubbel
- Valt het netwerk weg, dan werkt de Timing-laptop na 15 seconden vanzelf
  alleen verder, zodat je kan blijven klokken. Een groene balk bovenaan zegt
  dat zolang. Komt het netwerk terug, dan sluiten de andere laptops vanzelf
  weer aan en nemen ze de rondes van de Timing-laptop over
- Beheer › Rondes: klik op een ronde om een wissel te verschuiven met −1 s,
  −0,1 s, +0,1 s of +1 s, voor een wissel die een paar seconden te laat of te
  vroeg gedrukt werd ("Mitras −4, Wout +4"). Ziet het ernaar uit dat een
  wissel te laat gedrukt werd, dan staat dat tussen de rijen en kan het in één
  klik. Andere loper, Splitsen en Verwijderen staan nu in hetzelfde paneel
- Analyse › Exporteren › Excel heeft nu alles voor na de race in één
  bestand. Naast Rondes en Gebeurtenissen staan er vier nieuwe bladen:
  Lopers (elke loper, ook zonder rondes, met de antwoorden uit het
  inschrijvingsformulier zoals ze getypt zijn), Puntenlijst, Punten per ronde
  en Puntenregels. De punten zijn formules op Puntenregels: verander daar een
  factor en alle punten rekenen opnieuw. Het bestand bevat e-mailadressen en
  telefoonnummers en staat daarom niet op de publieke schermen

### Changed

- Alleen verder werken kan alleen op de Timing-laptop. Is die kapot, dan kan
  een andere laptop Timing overnemen en in dezelfde stap alleen verder werken
- Komen twee delen van de groep weer samen, dan houdt het deel met de
  Timing-laptop zijn gegevens, niet meer het deel met de meeste laptops.
  Rondes die met Alleen verder geteld werden, gaan zo niet meer verloren. Een
  laptop die toch eigen rondes moet opgeven, zegt in Beheer › Systeem hoeveel
  en in welke backup ze staan
- Een laptop met lopers koppelt nu ook voor de race: zijn lopers en labels
  komen bij die van de groep, in plaats van in een backup te verdwijnen.
  Dezelfde persoon (zelfde naam, e-mail en telefoon) staat er één keer in. Ook
  vanzelf koppelen werkt zo, en een laptop in een groep heeft nu ook Koppelen
- De race telt pas als gestart vanaf 10 rondes. Een paar testrondes beslissen
  dus niet meer welke laptop zijn gegevens houdt bij het koppelen
- Het dagdeel van een ronde hangt nu af van het uur waarop de ronde startte,
  niet meer van het uur waarop ze eindigde. Zo rekenen het Binnenscherm en de
  Excel hetzelfde als het prijzensysteem

## [5.2.0] - 2026-10-19

Laptops koppelen alleen met dezelfde versie: zet 5.2.0 op alle laptops.

### Changed

- Wat een knop deed, staat nu in een melding rechtsonder in plaats van in een
  groene balk die de pagina naar beneden duwt. Een groen vinkje betekent
  gelukt; die melding verdwijnt na 7 seconden, of als je erop klikt. Een rood
  uitroepteken betekent mislukt; die melding blijft staan tot je erop klikt.
  Met de muis erop blijft ze ook staan. Dit geldt in heel Beheer, bij het
  aanmelden in Wachtrij en in het lopersprofiel
- Onder de Timing-knop staat de bevestiging als een groen vinkje met één
  regel, zonder kader
- Race wissen en Backup terugzetten tonen geen bestandsnaam meer, maar de naam
  van de backup zoals de lijst hem toont (Vóór race wissen, Vóór terugzetten)
- Bij het importeren van de inschrijvingen blijven de rijen met een fout op
  het scherm staan, in een lijst onder Nakijken in het bestand

## [5.1.0] - 2026-10-19

Laptops koppelen alleen met dezelfde versie: zet 5.1.0 op alle laptops.

### Added

- Beheer › Systeem & herstel: Alles wissen, naast Race wissen. Het doet wat
  Race wissen doet en haalt ook alle lopers met hun inschrijvingen weg, op
  alle gekoppelde laptops. Labels, logo's en instellingen blijven. Eerst maakt
  de hoofdlaptop een backup (Vóór race wissen); die terugzetten maakt het
  wissen ongedaan

## [5.0.0] - 2026-10-19

Laptops koppelen alleen met dezelfde versie: zet 5.0.0 op alle laptops.

### Added

- De import van de inschrijvingen geeft lopers een label voor hun
  studiefase: 2de bach, 3de bach, 1ste master of 2de master, elk met een eigen
  kleur. 1ste bach valt onder 1ste jaar. Wat iemand zelf intypte, krijgt geen
  label. Zo kunnen het Binnenscherm en het Competitiescherm de jaren tegen
  elkaar zetten. Lopers die al eerder geïmporteerd zijn, houden hun labels;
  importeer opnieuw op een lege laptop of zet het label met de hand

### Changed

- Beheer › Lopers gebruikt de volle breedte. De beschikbare uren staan
  samengevoegd (`di 20u – wo 2u · wo 10–20u`, of `Hele race`), met een balk
  van de 24 race-uren ervoor. Klik ergens op een rij om het profiel te
  openen; de knop Profiel is weg. Verwijder verschijnt pas op de rij onder de
  muis
- Pakketten bijgewerkt, onder andere Electron 44.7.0, Express 5.3.0 en Vite
  8.3.4

### Fixed

- De import leest het tijdstip van elk antwoord weer uit het formulier van
  2026 (kolom Tijdsstempel). Vult iemand het formulier twee keer in, dan
  telt het nieuwste antwoord

## [4.6.1] - 2026-10-19

Laptops koppelen alleen met dezelfde versie: zet 4.6.1 op alle laptops.

### Changed

- Het Buitenscherm toont de eerste ronde van de race nooit als record. Die
  ronde loopt een langer parcours, dus ze flitst niet en latere rondes moeten
  ze niet kloppen. De tweede ronde is het eerste record van de race. Voor de
  rest telt de eerste ronde gewoon mee

## [4.6.0] - 2026-10-19

Laptops koppelen alleen met dezelfde versie: zet 4.6.0 op alle laptops.

### Added

- Timing heeft een knop Burgie gepakt onderaan, naast Laatste wissel ongedaan
  maken. Hij doet hetzelfde als de knop in Beheer › Publiek en heeft geen
  sneltoets
- Beheer › Systeem & herstel: Race wissen na een testrun. Het wist rondes,
  wissels en race-events en zet de race terug op niet gestart. Lopers, labels,
  logo's en instellingen blijven. Eerst maakt de hoofdlaptop een backup
  (Vóór race wissen); die terugzetten maakt het wissen ongedaan
- Beheer › Labels toont wie in elk label zit. Lopers toevoegen of uit een
  label halen kan daar meteen, zonder elk profiel te openen
- Het profiel van een loper heeft een knop Opwarmen
- Bellen op Wachtrij › Nu beschikbaar en in het profiel toont een QR-code met
  het gsm-nummer. Scan hem met een gsm om te bellen; de laptops kunnen zelf
  niet bellen
- Apolloon Wrapped: na de race maakt een script per loper met minstens één
  ronde een story-afbeelding en mailt die. Het draait thuis op een backup van
  de race, niet op de laptops op het event (zie `docs/wrapped.md`)
- Competitiescherm (`/display/competitions`): kies zelf welke ploegen tegen
  elkaar strijden (bv. 1ste, 2de en 3de jaar) met Competitie toevoegen. Elke
  competitie is een staafdiagram met de leider bovenaan, het aantal rondes
  aan het einde van elke staaf en de achterstand op de leider. Een ploeg die
  een andere inhaalt, schuift naar haar nieuwe plaats. Naast de competities
  staat de top 20 op meeste rondes. Open het naast het Binnenscherm in een
  tweede browser; de gekozen competities staan in het adres

### Changed

- Het Binnenscherm toont de laatste 25 lopers en de top 25 op punten naast
  elkaar. Elke ronde toont de punten die ze opleverde (tijdcoëfficiënt en dagdeel samen). Het scherm wisselt niet meer
  tussen meeste rondes en punten; meeste rondes en de competities staan nu op
  het Competitiescherm
- De demowedstrijd (`DEMO_RACE`) geeft elke loper verzonnen
  inschrijvingsgegevens: e-mail, gsm-nummer, uren en de andere antwoorden van
  het formulier. De uren noemen geen weekdag (`21-22u`), zodat Nu beschikbaar
  op Wachtrij op elke dag van de demo elk uur lopers toont
- Een competitie die al op het Competitiescherm staat, kan niet nog eens
  toegevoegd worden
- Het Buitenscherm toont alleen labels van zusterverenigingen bij de loper,
  met een groter logo en kleinere namen
- Overzicht toont de racestatus niet meer in de kop
- Na aanmelden op Wachtrij zegt het scherm welke loper naar Opwarming ging
- Enter bewaart een nieuwe loper in Nieuwe loper. In Beheer › Rondes verplaatst
  of splitst Enter een ronde na het typen van een lopernummer
- Beheer › Rondes houdt de rijen op hun plaats zolang de muis op de tabel
  staat, zodat een nieuwe ronde de knoppen niet verschuift
- Pakketten met bekende beveiligingslekken bijgewerkt (onder andere
  `proxy-addr`)

### Fixed

- Een klik op een Wachtrij-rij die net onder de muis schoof, doet niets meer.
  Zo gaat geen verkeerde loper terug naar opwarming als Timing een wissel
  klokt
- Dubbel klikken op Opwarmen in Loper zoeken of in het profiel meldt één
  loper aan en opent niet meer Uit de wachtrij halen
- Rijen op het Competitiescherm springen niet meer weg als een competitie
  toegevoegd of verwijderd wordt

## [4.5.0] - 2026-10-12

Laptops koppelen alleen met dezelfde versie: zet 4.5.0 op alle laptops. Deze
versie bevat ook de herstelde vensterknoppen uit 4.4.1.

### Changed

- Het Buitenscherm toont de loper op de piste op een blauwe band, met de
  volgende loper eronder als Volgende racer
- Het Binnenscherm rekent punten volgens het prijzensysteem van 2026. Een
  ronde is 20 punten × de tijdcoëfficiënt × de factor van het dagdeel. De
  tijdcoëfficiënt is 1, plus 0,125 per seconde onder 1:25. Het dagdeel telt
  ×1,3 van 0 tot 4 uur, ×1,8 van 4 tot 12 uur, ×1,3 van 12 tot 16 uur en ×1
  van 16 tot 24 uur. Punten staan met hoogstens één cijfer na de komma

### Removed

- De tijdelijke nachtploegen. Beheer › Ploegen & labels heet nu Beheer ›
  Labels. Bij het updaten verdwijnen de nachtploegen en hun leden ook uit de
  database; rondes die al gelopen werden houden hun labels

## [4.4.1] - 2026-10-11

Laptops koppelen alleen met dezelfde versie: zet 4.4.1 op alle laptops.

### Fixed

- De knoppen minimaliseren, maximaliseren en sluiten bovenaan het venster
  werken weer op Windows en Linux

## [4.4.0] - 2026-10-11

Laptops koppelen alleen met dezelfde versie: zet 4.4.0 op alle laptops.

### Added

- Een laptop zonder lopers koppelt zichzelf binnen enkele seconden met de
  andere laptops op het netwerk, zonder klik. Beheer › Systeem & herstel toont
  welke laptops zichzelf koppelden, en zegt waarom als het blijft mislukken
- Een kapotte laptop kan uit de groep: na 30 seconden zonder antwoord staat
  **Uit de groep halen** naast hem in Beheer › Systeem. Daarna maakt een
  reservelaptop er weer drie. Timing zegt wanneer een laptop uit de groep
  gehaald werd en wanneer een wijziging daar mislukt
- Beheer › Rondes: een ronde achteraf aan een andere loper geven, splitsen of
  verwijderen
- Beheer › Activiteit toont laptops die koppelen, wegvallen en terugkomen, en
  noemt de ronde die een ongedaan maken weghaalt
- De Windows-installatie opent de firewall voor gekoppelde laptops
- Laptops tonen elkaar met hun computernaam in plaats van hun adres
- Analyse vorig jaar tekent de mediaan en de trendlijn op de
  spreidingsgrafieken
- Beheer › Lopers: een knop onder de tabel toont de rest van de lopers. Zoeken
  op "verborgen" vindt lopers die niet in de wachtrij staan, en zoeken op een
  uur vindt elke loper wiens formulierblok dat uur dekt

### Changed

- Het Binnenscherm toont de laatste zes rondes als lijst in plaats van de live
  timer en drie kaarten
- Koppelen tijdens een overname wacht op de nieuwe hoofdlaptop in plaats van
  te mislukken
- Een wijziging die de laptop niet bereikt, geeft een Nederlandse melding
- Een laptop met een beschadigd databasebestand opent toch: het bestand wordt
  opzij gezet
- Lange labelnamen blijven binnen hun label, hoverkleuren blijven niet hangen
  op aanraakschermen, en elke knop toont dat hij ingedrukt is
- Zoeken in Beheer › Rondes en Activiteit negeert accenten

### Fixed

- Koppelen maakt nooit de laptop met de lopers leeg. Een lopende race blijft
  behouden als een reservelaptop met meer lopers of met een afgelopen
  oefenrace gekoppeld wordt. Twee laptops zonder lopers houden de gegevens van
  de voorbereide laptop
- Na een netwerkonderbreking kiest de groep een nieuwe hoofdlaptop. Een laptop
  die uit de groep gehaald werd, blijft eruit nadat een reserve aansluit
- Een laptop die uit stond, haalt zijn achterstand in over een trage kabel.
  Logo's worden niet meer opnieuw verstuurd naar een laptop die uit staat
- Dubbel klikken verplaatst één loper in de Wachtrij, houdt de race lopend bij
  Verder en bewaart één Burgie gepakt-moment
- Dubbele drukken (minder dan 20 seconden) tellen niet meer mee voor snelste
  en gemiddelde rondetijden op Overzicht, Timing, Binnenscherm en Analyse, voor
  de recordflits op het Buitenscherm en voor de Punten-rangschikking. Een
  gesplitste ronde laat geen record oplichten
- De getalvelden in Tactiek houden wat getypt is
- De Excel-export toont Brusselse tijd en hele minuten. Tv's en browsers in een
  andere tijdzone tonen ook Brusselse tijd
- De publieke schermen tonen dat de race voorbij is na Race beëindigen
- Timing klokt met Enter na een klik op de zijbalk en na de vraag over ongedaan
  maken of beëindigen
- Overzicht toont "Even niemand" als de piste midden in de race leeg is
- Vast netwerkadres behoudt de prefixlengte van het netwerk en toont de
  adresbron ook op trage Windows-laptops
- Een tv houdt zijn lichte of donkere weergave wanneer hij naar een andere
  laptop verhuist
- De import neemt beide personen op wanneer twee rijen hetzelfde nummer
  hebben, en leest een rondetijd die in Excel als 1:20 getypt is als 1 minuut
  20
- Een race die nooit startte, kan niet beëindigd worden
- Ongedaan maken werkt nog nadat de loper van de laatste wissel verwijderd is
- De JSON-exports in Analyse worden gedownload in plaats van het venster te
  vervangen
- De uurgrafiek in Analyse zegt dat er geen rondes zijn als labels aan staan
- Het muiswiel scrolt de Wachtrij ook boven een baan
- Een knop die een tekstveld opent, zet de cursor erin

## [4.3.0] - 2026-10-07

Laptops koppelen alleen met dezelfde versie: zet 4.3.0 op alle laptops.

### Added

- Inschrijvingen importeren kan nu ook rechtstreeks uit het Excel-bestand
  (`.xlsx`) van het formulier, naast de CSV-export
- Het profiel toont het antwoord op "snelste (test)ronde" uit het formulier
- Op Windows en Linux (AppImage) downloadt de app een nieuwe versie op de
  achtergrond. Eén klik op **Nu installeren en herstarten** maakt een backup,
  installeert ze, ruimt het installatiebestand op en start de nieuwe versie.
  Nooit vanzelf en niet terwijl de wedstrijd loopt; op macOS blijft het een
  download
- De desktop-app toont meteen een startvenster terwijl de databank opent, in
  plaats van enkele seconden niets
- Een laptop zonder lopers opent op een welkomstscherm: inschrijvingen
  importeren op deze laptop, of in één klik koppelen aan een laptop die op het
  netwerk gevonden is
- Beheer › Systeem & herstel › Over deze installatie toont de versie en de
  gegevensmap, opent de logmap en kopieert een diagnose om door te sturen
- De desktop-app meldt een nieuwere versie, met het installatiebestand voor
  die laptop. Installeren blijft een bewuste stap: alle laptops moeten dezelfde
  versie hebben
- Gepubliceerde versies staan ook in de publieke repository
  `SnaetWarre/apolloon-releases`, zodat iedereen ze kan downloaden
- Beheer opent op het gekozen onderdeel via het adres (`/admin?section=system`)
- Timing vraagt "Toch afklokken?" bij een druk minder dan 20 seconden na de
  vorige, zodat een dubbele druk geen ronde van een halve seconde bewaart
- "Laatste wissel ongedaan maken" na "Race beëindigen" heropent de race, met
  de loper die op de piste was en dezelfde starttijd

### Changed

- Installatiebestanden heten nu `Apolloon-Telsysteem-<versie>-…`, zonder
  spatie, zodat de app ze zelf kan vinden en installeren
- Als de app niet kan starten, zegt ze in het Nederlands waarom (poort in
  gebruik, volle schijf, beschadigde databank, …) en kan je opnieuw proberen of
  de logmap openen, in plaats van een Engelse foutmelding en afsluiten
- Schermen horen live wijzigingen via een tRPC-abonnement in plaats van
  Socket.IO, en zien binnen tien seconden dat de verbinding met hun laptop weg
  is
- Schermen halen na een wijziging alleen op wat veranderd is in plaats van de
  hele wedstrijd: een ronde kost elk scherm een paar KB in plaats van ruim
  100 KB, en de schermen tonen ze sneller op een traag netwerk
- De status van de laptops komt binnen wanneer ze verandert, in plaats van dat
  elk scherm er elke twee seconden om vraagt
- De Wachtrij laadt de inschrijvingen niet meer opnieuw na elke wijziging als
  ze niet veranderd zijn
- Een loper toevoegen laat nu ook meerdere andere labels toe (bv. 1ste jaar en
  Dames), net als een loper bewerken; alleen het speedteam blijft er één
- Een lopende loper heet overal "Op de piste"
- Elke rij met een naam wordt geïmporteerd, zoals ze getypt is: ook met `////`
  als e-mail of "contacteer Thomas" als telefoon. Bellen en Mailen verschijnen
  alleen bij een echt nummer of adres. Een opnieuw geïmporteerde rij vindt
  haar loper terug via het e-mailadres, het tijdstip van inschrijven of rij en
  naam, zodat dezelfde nepmail lopers niet meer door elkaar haalt
- Is het rijnummer van een nieuwe inschrijving al in gebruik, dan komt de loper
  binnen zonder nummer en zegt de import welke rij het was. De import toont nu
  ook waarom een rij overgeslagen werd
- De doelen (rondes) van ploegen, labels en lopers zijn weg. Competities op het
  Binnenscherm vergelijken de ploegen op hun rondes
- Tv's en browsers op een laptop die uitvalt, ook door een stroomonderbreking
  of een losgetrokken kabel, gaan binnen enkele seconden naar een andere laptop
- De desktop-app start sneller
- De tv-schermen worden groter op 4K, en Competities toont de volledige
  ploegnamen
- Lange namen op het Buitenscherm worden kleiner in plaats van afgeknipt
- De Wachtrij blijft leesbaar in een smal venster
- Backups gaan terug tot het begin van een race van 24 uur, en handmatige
  backups worden niet meer verdrongen door automatische veiligheidskopieën
- Beheer › Activiteit noemt bij een aangepast lopersprofiel alleen wat echt
  veranderde
- Zoeken op een naam zonder accenten vindt de loper ("zoe" vindt Zoë); in
  Beheer › Lopers kan je ook zoeken op de status en bron zoals de tabel ze toont
- Laptops koppelen kan ook met alleen het IP-adres

### Fixed

- Het lopersprofiel toont de uren van woensdag uit het formulier (blokken van
  twee uur, zoals `12-14u (woensdag)`) als aangeduid; één uur eruit halen laat
  het andere staan
- Beheer › Systeem op een Windows-laptop houdt de server niet meer vast terwijl
  het netwerkprofiel wordt gelezen; de laptop blijft hartslagen sturen en
  drukken beantwoorden
- De demowedstrijd (`DEMO_RACE`) start niet op gekoppelde laptops, omdat ze de
  database rechtstreeks aanpast
- Schermen houden de processor niet meer bezig terwijl er niets gebeurt: het
  knipperende live-bolletje, de oplichtende rij en de voortgangsbalken worden
  door de grafische kaart getekend in plaats van de hele pagina elke frame
  opnieuw. Op een trage laptop zakt de Wachtrij van ongeveer 50% naar 4%
  processorgebruik en het Binnenscherm van 16% naar 2%
- Opnieuw importeren behoudt wat in de app verbeterd werd: de naam, het
  e-mailadres, de telefoon en de uren bij hetzelfde formulierantwoord, en de
  labels en historische tijden bij een gewone lijst zonder die kolommen.
  Lopers die één e-mailadres delen, blijven apart, en een gewone lijst hernoemt
  geen lopers uit het formulier meer
- Hetzelfde bestand opnieuw kiezen nadat het aangepast werd, importeert de
  nieuwe inhoud in plaats van de oude
- CSV-bestanden van Excel op Windows (Windows-1252) en lijsten zonder lege
  laatste kolommen worden correct ingelezen
- CSV-exports tonen accenten correct in Excel en worden nooit als formule
  uitgevoerd
- Een afgesloten race kan niet nog eens beëindigd worden; dat verschoof de
  eindtijd
- Ongedaan maken neemt de laatste wissel terug, ook als twee wissels op
  hetzelfde moment vielen, en elk scherm toont daarna dezelfde volgende loper
- Een verouderde klik in de Wachtrij haalt de loper die net gestart is niet
  meer van de piste
- Het filter "Beschikbaar tijdens" vindt lopers ook als hun uren anders
  geschreven zijn (een blok van twee uur of losse uren)
- Vergeten wissels (rondes langer dan tien minuten) tellen niet meer mee in de
  gemiddelden op het Binnenscherm
- Analyse toont de rondes zonder label weer nadat een label uit en aan gezet
  werd
- Lijsten die per uur wisselen, zoals "Nu beschikbaar", wisselen op het uur van
  de groepsklok
- Een herstart voegt de ingebouwde labels niet opnieuw toe, en een label dat
  op een andere laptop verwijderd werd, komt niet terug als nieuw label
- Een laptop die veel logo's gemist had, haalt ze in in plaats van vast te
  lopen, en een gewiste laptop die opnieuw gekoppeld wordt, neemt de plaats van
  zijn oude versie in

## [4.2.0] - 2026-10-01

Laptops koppelen alleen met dezelfde versie: zet 4.2.0 op alle laptops.

### Added

- Beheer › Systeem & herstel › Backup terugzetten zet alle gekoppelde laptops
  tegelijk terug naar een backup, zonder laptops af te sluiten of opnieuw te
  koppelen. De huidige toestand wordt eerst als backup bewaard
- Beheer › Activiteit toont elke wijziging met het tijdstip, het scherm en het
  adres waarvan ze kwam, op elke laptop dezelfde lijst
- Terwijl de wedstrijd loopt, houdt de desktop-app het scherm aan en de laptop
  wakker, en vraagt ze bevestiging voor ze sluit
- Een scherm dat vastloopt, toont een herstelscherm in plaats van een lege
  pagina; de publieke schermen proberen zelf opnieuw. De fout komt in
  `server.log`
- Het venster opent op dezelfde plaats en grootte als waar het gesloten werd
- Releases vermelden hun wijzigingen en hebben een `SHA256SUMS.txt`

### Changed

- Een pagina van de desktop-app die crasht of tien seconden niet reageert,
  wordt vanzelf opnieuw geladen
- Links naar andere sites openen in de browser in plaats van in het
  app-venster
- Timing toont een wissel zodra de spatiebalk ingedrukt wordt, en de knop
  blijft bruikbaar terwijl de laptops de wissel bevestigen
- Wijzigingen in de wachtrij verschijnen meteen en komen aan in de volgorde
  waarin erop geklikt werd; klikken tijdens het opslaan gaan niet meer verloren
- Pagina's laden hun gegevens vooraf en verspringen niet meer wanneer die
  binnenkomen. Tactiek laadt de referentie van vorig jaar maar één keer
- Onderliggende bibliotheken bijgewerkt

### Fixed

- De lopende rondetijd op Timing bleef stilstaan
- Een loper in de wachtrij sprong na een klik soms terug naar de vorige
  plaats

## [4.1.0] - 2026-09-30

Laptops koppelen alleen met dezelfde versie: zet 4.1.0 op alle laptops. De app
heet nu Apolloon Telsysteem en installeert naast de oude "Leuven 24h Tracker";
verwijder die oude app.

### Added

- Analyse › Exporteren heeft een Excel-bestand met de rondes en de
  gebeurtenissen: Nederlandse kolommen, tijden in Belgische tijd en rondetijden
  waarmee Excel kan rekenen. De CSV- en JSON-exports blijven voor MATLAB en R

### Changed

- De app heet Apolloon Telsysteem in plaats van Leuven 24h Tracker. Met de
  nieuwe naam en `appId` installeert ze als een nieuwe app met een eigen, lege
  datamap
- "Kobe's tactiek" heet nu Tactiek
- De desktop-app tekent zijn eigen titelbalk in plaats van het venster van het
  besturingssysteem
- Een database van vóór 4.0 wordt niet meer omgezet. De app zet ze ongewijzigd
  opzij als `app.retired-<tijd>.sqlite` en begint met een lege database en een
  nieuwe laptop-identiteit. Databases van 4.0 en later blijven gewoon behouden

### Fixed

- De kerncijfers op Tactiek worden niet meer afgekapt
- De wedstrijdgereedheid spreekt van gekoppelde laptops in plaats van een
  tweede laptop, en belooft geen klokcontrole meer
- Bij het opstarten vergelijkt de app elke tabel met de huidige structuur, in
  plaats van te vertrouwen op het schemanummer. Wijkt een tabel af, dan wordt
  ze herbouwd met behoud van alle gegevens, na een kopie
  (`app.pre-repair-<datum>.sqlite`). Lukt dat niet, dan start de server niet en
  staat de reden in de foutmelding
- Een database die een andere laptop doorstuurt, wordt op dezelfde manier
  gecontroleerd

## [4.0.2] - 2026-09-30

Laptops koppelen alleen met dezelfde versie: zet 4.0.2 op alle laptops.

### Fixed

- Een laptop met een database uit de allereerste versie toonde "Geen verbinding
  met de lokale server" (500): de lopers-tabel miste kolommen. Die tabel wordt
  nu bij het opstarten herbouwd, met behoud van lopers en rondes

### Added

- Kan de server iets niet laden, dan staat de reden nu op het scherm in plaats
  van alleen een foutcode
- De server schrijft zijn meldingen naar `server.log` in de app-map, ook op
  Windows waar er geen console is

## [4.0.1] - 2026-09-30

Laptops koppelen alleen met dezelfde versie: zet 4.0.1 op alle laptops.

### Changed

- De app heeft nu hetzelfde Apolloon-icoon als de site, in plaats van het paarse
  "24h"-icoon
- Er is geen macOS-build voor Intel meer; macOS Apple Silicon blijft

## [4.0.0] - 2026-09-30

Vereist een nieuwe major versie: laptops met deze versie koppelen niet met 3.x.
De database migreert automatisch naar schema 13 en bewaart eerst een kopie
(`app.pre-schema-13.sqlite`).

### Added

- Rondetijden komen uit het moment van de toetsdruk zelf en worden tussen twee
  drukken op dezelfde klok gemeten: netwerk, een drukke server of
  klokcorrecties veranderen een ronde niet meer
- Drie laptops vormen één groep en nemen vanzelf van elkaar over: valt een
  laptop uit, dan kiezen de andere binnen enkele seconden wie de wijzigingen
  ordent en werken ze gewoon verder. Een wijziging is pas bewaard als twee
  laptops ze hebben, dus een uitgevallen laptop kost geen bevestigde gegevens
- Een toetsdruk tijdens een overname wacht even en telt daarna één keer, met
  de tijd van de druk
- Elke laptop werkt in haar eigen venster; wijzigingen gaan vanzelf naar de
  laptop die ze ordent
- Een laptop die terugkomt (herstart of kabel terug) werkt zichzelf bij
- De status zegt in gewone woorden hoe het gaat ("Alles veilig", "Eén laptop
  onbereikbaar", "Te weinig laptops bereikbaar")
- Alle laptops delen één klok, ook na een overname
- Browsers en tv's schakelen vanzelf naar een andere laptop als de hunne
  wegvalt
- De overname wordt getest met duizenden gesimuleerde runs vol uitvallende
  laptops, losse kabels, dichtgeklapte schermen en verspringende klokken, en
  met `npm run rehearse`: drie echte servers onder willekeurige storingen
  terwijl een bot rondes klokt

### Changed

- De gekoppelde laptops kiezen bij meerderheid één laptop die alle wijzigingen
  ordent; de andere houden een live kopie bij. Dit vervangt de synchronisatie
  waarbij elke laptop los schreef: geen syncconflicten, quarantaine,
  timingcontroller of koppelcode meer, en niemand hoeft handmatig over te
  nemen. Alleen als twee van de drie laptops echt weg zijn, kan de laatste in
  Beheer "Alleen verder werken"
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
- De wachtrijstatus staat op de loper zelf in plaats van in een aparte tabel
- Laptops vinden elkaar zelf op het netwerk (UDP 45737): een nieuwe laptop
  toont de andere in Beheer en koppelt met één klik, en gekoppelde laptops
  vinden elkaar terug als hun adressen veranderen (bv. een andere router)
- Code wordt gecontroleerd met oxlint en opgemaakt met oxfmt; de
  browsercontroles draaien in CI
- De schermen bewegen kort mee met wat je doet: knoppen, dialogen, meldingen
  en tabbladen hebben overgangen, en een nieuwe ronde of loper schuift
  zichtbaar op zijn plaats. Wie in het besturingssysteem "minder beweging"
  kiest, ziet geen animaties

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
