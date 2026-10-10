# Kart Analytics

Logt 24/7 elke ronde van de live timing van **Kart en Fun Fabriek (Assen)** en laat er analyses op los: per kart, per coureur, per heat en per tijdstip.

- **Logger** – luistert dag en nacht naar de openbare live timing (SMS-Timing WebSocket). Geen inloggegevens nodig.
- **Database** – alle rondes in één SQLite-bestand (`data/kart.db`).
- **Analysescherm** – F1-stijl dashboard op `http://<server>:8095`.
- **API** – JSON-eindpunten, bijvoorbeeld voor Home Assistant.
- **Automatisch bijwerken** – de container haalt zelf nieuwe versies van GitHub op; Watchtower houdt de Node.js-basis bij.

Geen externe npm-pakketten: alleen ingebouwde Node.js-modules (Node 22.13+).

## Installeren met Dockge (Unraid)

1. Open Dockge → **+ Compose**.
2. Stacknaam: `kart-analytics`.
3. Plak de inhoud van [`compose.yaml`](compose.yaml) en klik **Deploy**.
4. Open `http://<ip-van-je-unraid>:8095`.

De map `/opt/stacks/kart-analytics/data` bevat de database. Die blijft staan bij updates en herstarts; maak er gerust een back-up van.

## Wat analyseert het?

| Scherm | Inhoud |
|---|---|
| Overzicht | live heat, snelste/traagste kart, "welke kart kies ik?", jouw cijfers en gevolgde coureurs, laatste heats |
| Karts | ranglijst met kart-effect (gecorrigeerd voor de coureur), snelste, top-10%, mediaan, gemiddelde, langzaamste, spreiding |
| Kart-detail | alle rondes over tijd met trendlijn, per dag snelste/mediaan/langzaamste, verdeling, rijders, top 10 |
| Coureurs / detail | beste, mediaan, constantheid, progressie, rondetijden per heat, prestaties per kart |
| Heats | rondetijden per ronde per coureur, gele vlaggen |
| Omstandigheden | opwarmcurve (ronde-in-heat), tijdstip van de dag, dag van de week |

**Schone rondes.** Uitrijrondes, gele vlaggen (meer dan de helft van het veld tegelijk >15% langzamer) en losse uitschieters (>12% boven het eigen niveau, bijvoorbeeld een spin) worden gemarkeerd en niet meegeteld in de statistieken.

**Kart-effect.** Elke ronde wordt eerst vergeleken met de rest van de heat (zelfde omstandigheden) en daarna met het eigen niveau van de coureur over alle karts. Wat overblijft is het effect van de kart in seconden per ronde.

## API

Alle eindpunten accepteren `?period=7d|30d|90d|365d|all` en `?group=Volwassenen|Kids|Alle`.

| Eindpunt | |
|---|---|
| `/api/summary` | status logger, totalen |
| `/api/live` | laatste live bericht |
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
| `AUTO_UPDATE` | `true` | elke `UPDATE_INTERVAL_MIN` minuten nieuwe versie ophalen |
| `UPDATE_INTERVAL_MIN` | `60` | |

## Privacy

Deze repository is openbaar. Er staan **geen** persoonlijke sleutels of tokens in, en die horen er ook nooit in. De logger gebruikt alleen de openbare live timing.
