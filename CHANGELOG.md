# Changelog

All notable changes to Apolloon Telsysteem will be documented in this file.

## [Unreleased]

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
