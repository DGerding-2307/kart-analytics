# Kart Analytics

Logt 24/7 elke ronde van de live timing van **Kart en Fun Fabriek (Assen)**, **Karting Emmen** en **Kartcentrum Lelystad** en laat er analyses op los: per kart, per coureur, per heat en per tijdstip. Rechtsboven in het scherm kies je met een keuzelijst welke baan je bekijkt.

- **Logger** – luistert dag en nacht naar de openbare live timing van beide banen: Assen via SMS-Timing, Emmen en Lelystad via Apex Timing ([Emmen](https://live.apex-timing.com/karting-emmen/), [Lelystad](https://live.apex-timing.com/kartcentrum-lelystad/); `apex.js`). Geen inloggegevens nodig.
- **Database** – alle rondes in één SQLite-bestand (`data/kart.db`).
- **Analysescherm** – F1-stijl dashboard op `http://<server>:8095`.
- **API** – JSON-eindpunten, bijvoorbeeld voor Home Assistant.
- **Automatisch bijwerken** – de container haalt zelf nieuwe versies van GitHub op; Watchtower houdt de Node.js-basis bij.

Geen externe npm-pakketten: alleen ingebouwde Node.js-modules (Node 22.13+).

## Installeren met Portainer (Unraid)

1. Open Portainer → kies je omgeving (meestal *local*) → **Stacks** → **+ Add stack**.
2. Naam: `kart-analytics`, bouwmethode **Web editor**.
3. Plak de inhoud van [`compose.yaml`](compose.yaml) en klik **Deploy the stack**.
4. Open `http://<ip-van-je-unraid>:8095`.

Dockge werkt ook: **+ Compose** → zelfde inhoud plakken → **Deploy**.

De map `/mnt/user/appdata/kart-analytics/data` bevat de database. Die blijft staan bij updates en herstarts; maak er gerust een back-up van.

## Wat analyseert het?

| Scherm | Inhoud |
|---|---|
| Live timing | lopende heat als timing tower (elke 1,5 s ververst): positie en inhaalacties, laatste/beste ronde in paars/groen/geel, gap, interval, rondeverloop, snelste ronde, rondetijdengrafiek van de heat |
| Overzicht | live heat, snelste/traagste kart, "welke kart kies ik?", jouw cijfers en gevolgde coureurs, laatste heats |
| Karts | ranglijst met kart-effect (gecorrigeerd voor de coureur), snelste, top-10%, mediaan, gemiddelde, langzaamste, spreiding |
| Kart-detail | alle rondes over tijd met trendlijn, per dag snelste/mediaan/langzaamste, verdeling, rijders, top 10 |
| Volgen | jij en gevolgde coureurs naast elkaar, progressie in één grafiek, hun laatste heats, onderlinge heats (wie was sneller). Volgen met ☆ in Coureurs, Live timing en heats |
| Coureurs / detail | beste, mediaan, constantheid, progressie, rondetijden per heat, prestaties per kart |
| Heats | rondetijden per ronde per coureur, gele vlaggen |
| Omstandigheden | opwarmcurve (ronde-in-heat), tijdstip van de dag, dag van de week |

**Schone rondes.** Uitrijrondes, gele vlaggen (meer dan de helft van het veld tegelijk >15% langzamer) en losse uitschieters (>12% boven het eigen niveau, bijvoorbeeld een spin) worden gemarkeerd en niet meegeteld in de statistieken.

**Kart-effect.** Elke ronde wordt eerst vergeleken met de rest van de heat (zelfde omstandigheden) en daarna met het eigen niveau van de coureur over alle karts. Wat overblijft is het effect van de kart in seconden per ronde.

## API

Alle eindpunten accepteren `?track=assen|emmen|lelystad` (standaard `assen`), `?period=7d|30d|90d|365d|all` en `?group=Volwassenen|Kids|Alle` (alleen Assen; de andere banen tonen altijd alle heats).

| Eindpunt | |
|---|---|
| `/api/tracks` | lijst van banen |
| `/api/summary` | status logger, totalen |
| `/api/live` | laatste live bericht (`?laps=1`: ook alle rondes van de lopende heat) |
| `/api/karts` | statistieken per kart |
| `/api/kart/<nr>` | alle rondes + dagcijfers van één kart |
| `/api/drivers` | statistieken per coureur |
| `/api/driver/<naam>` | detail van één coureur |
| `/api/heats`, `/api/heat/<id>` | heats |
| `/api/conditions` | tijdstip, weekdag, ronde-in-heat |
| `/api/export.csv` | alle rondes als CSV |

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard | |
|---|---|---|
| `PORT` | `8095` | poort van het dashboard |
| `DB_PATH` | `/data/kart.db` | database |
| `RESOURCE_KEY` | `26932@kartenfunfabriek` | baan in SMS-Timing |
| `EMMEN` | `true` | Karting Emmen ook loggen |
| `APEX_URL` | `wss://live-data.apex-timing.com:10463/` | live timing Emmen |
| `CLEAN_MAX_MS_EMMEN` | `0` | tijdgrens schone ronde in Emmen (0 = geen) |
| `LELYSTAD` | `true` | Kartcentrum Lelystad ook loggen |
| `APEX_URL_LELYSTAD` | `wss://live-data.apex-timing.com:8383/` | live timing Lelystad |
| `CLEAN_MAX_MS_LELYSTAD` | `0` | tijdgrens schone ronde in Lelystad (0 = geen) |
| `AUTO_UPDATE` | `true` | elke `UPDATE_INTERVAL_MIN` minuten nieuwe versie ophalen |
| `UPDATE_INTERVAL_MIN` | `60` | |

## Privacy

Deze repository is openbaar. Er staan **geen** persoonlijke sleutels of tokens in, en die horen er ook nooit in. De loggers gebruiken alleen de openbare live timing.

## Hoe Emmen en Lelystad worden gelogd

Apex Timing stuurt geen losse rondes maar wijzigingen in de tijdentabel. Een ronde wordt opgeslagen zodra bij een coureur het aantal rondes omhoog gaat en de laatste rondetijd verandert. De tabel die direct na het verbinden binnenkomt, geldt als nulpunt: rondes die toen al gereden waren worden niet opgeslagen. Alle rondes staan in dezelfde database als Assen; elke heat heeft een kolom `track` (`assen`, `emmen` of `lelystad`).

Nog een Apex-baan toevoegen: zoek de `configPort` op in `https://live.apex-timing.com/<baan>/javascript/config.js`, tel er 3 bij op en voeg een regel toe aan `TRACKS` in `server.js` en een optie in de keuzelijst in `public/index.html`.
