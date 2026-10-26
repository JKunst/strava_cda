# WindWatt (webapp)

Statische webapp: hardloopvermogen met wind (Open-Meteo, per trackpunt), helling en duwkar. Draait volledig in de browser; Strava-sleutels en tokens staan alleen in de opslag van je eigen telefoon.

## Op GitHub Pages zetten

```bash
cd windwatt-pwa
git init && git add . && git commit -m "WindWatt webapp"
gh repo create windwatt --public --source . --push
gh api -X POST repos/{owner}/windwatt/pages -f "source[branch]=main" -f "source[path]=/"
```

De app staat daarna op `https://<gebruikersnaam>.github.io/windwatt/`. (Pages op een privé-repo vraagt GitHub Pro; de code bevat geen geheimen, dus public is prima.)

## Strava koppelen

1. Ga naar https://www.strava.com/settings/api en maak een app (of gebruik die van de Python-versie).
2. **Authorization Callback Domain**: `<gebruikersnaam>.github.io`
3. Open de app op je telefoon → Instellingen → vul Client ID en Client secret in → **Koppel met Strava**.
4. Zet de pagina op je beginscherm (Safari: Deel → Zet op beginscherm; Chrome: menu → App installeren).

Lukt de koppeling niet, plak dan bij Instellingen een refresh token (bijv. uit `windwatt.db` van de Python-versie, tabel `kv`, sleutel `token`).

## Lokaal testen

```bash
python3 -m http.server 8000   # http://localhost:8000
```

Strava-koppeling werkt lokaal met callback-domein `localhost`.

## Bestanden

- `physics.js` – rekenmodel (zelfde als `physics.py`, uitkomsten gecontroleerd)
- `app.js` – Strava, Open-Meteo, grafieken, kaart, opslag
- `index.html` – opmaak
- `sw.js`, `manifest.webmanifest` – installeerbaar en offline app-shell
