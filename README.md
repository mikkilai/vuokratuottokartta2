# Vuokratuottokartta

Vanhojen osakeasuntojen brutto- ja nettovuokratuotto postinumeroalueittain
koko Suomesta, kartalla.

**Miten se toimii:** klikkaat aluetta kartalta ja näet neliöhinnan,
keskineliövuokran, lasketun brutto- ja nettotuoton sekä taustatiedot
(väkiluku, mediaanitulo). Nettotuoton oletukset (hoitovastike, vajaakäyttö,
varainsiirtovero) saa säätää itse. Kaikki data on Tilastokeskuksen virallista
avointa dataa — toteutuneita kauppoja, ei pyyntihintoja. Ei mainoksia,
ei kirjautumista.

## Käynnistys

Sovellus on täysin staattinen (ei build-vaihetta, ei riippuvuuksia
ajonaikaisesti — Leaflet on vendoroitu). Käynnistä mikä tahansa
staattinen palvelin repojuuressa:

```bash
python3 -m http.server 8000
# tai: npx serve .
```

ja avaa <http://localhost:8000>.

## Data

Repossa on mukana pieni **demo-aineisto** (`data/areas.geojson`,
42 suuntaa-antavaa esimerkkialuetta), jotta kartta toimii heti.
Demonäkymästä kerrotaan bannerissa.

Koko Suomen kattava virallinen aineisto haetaan ja rakennetaan yhdellä
komennolla (vaatii Node 18+ ja verkkoyhteyden):

```bash
node scripts/build-data.mjs
```

Skripti

1. hakee Paavo-postinumeroalueiden rajat, väkiluvun ja mediaanitulot
   Tilastokeskuksen WFS-rajapinnasta (`geo.stat.fi`),
2. hakee vanhojen osakeasuntojen neliöhinnat (StatFin/ashi) ja
   vapaarahoitteisten vuokra-asuntojen keskineliövuokrat (StatFin/asvu)
   postinumeroalueittain uusimmalta tilastovuodelta,
3. yhdistää aineistot, yksinkertaistaa geometrian
   (Ramer–Douglas–Peucker) ja kirjoittaa `data/areas.geojson`.

StatFin-taulukoiden tunnukset on määritelty skriptin alun `CONFIG`-osiossa.
Jos Tilastokeskus muuttaa taulukkorakennetta, skripti tulostaa
virhetilanteessa tietokannan taulukkolistan, josta oikean tunnuksen voi
poimia ja päivittää.

Demo-aineiston voi generoida uudelleen komennolla
`node scripts/make-demo-data.mjs`.

## Laskentakaavat

- **Bruttotuotto** = (keskineliövuokra × 12) ÷ neliöhinta × 100 %
- **Nettotuotto** = ((vuokra × (1 − vajaakäyttö) − hoitovastike) × 12)
  ÷ (neliöhinta × (1 + varainsiirtovero)) × 100 %

Oletukset (muutettavissa käyttöliittymän *Oletukset*-paneelista,
tallentuvat selaimen localStorageen):

| Oletus | Oletusarvo |
| --- | --- |
| Hoitovastike | 4,50 €/m²/kk |
| Vajaakäyttö | 5 % |
| Varainsiirtovero | 1,5 % |

## Rakenne

```
index.html            Sovelluksen runko
css/style.css         Tyylit
js/app.js             Karttalogiikka (vanilla JS + Leaflet)
vendor/leaflet/       Leaflet 1.9.4 (vendoroitu)
data/areas.geojson    Aineisto (demo tai build-data.mjs:n tuottama)
scripts/build-data.mjs     Virallisen aineiston haku ja rakennus
scripts/make-demo-data.mjs Demo-aineiston generointi
```

## Lisenssit

- Koodi: ks. [LICENSE](LICENSE)
- Tilastoaineisto: Tilastokeskus, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi)
- Karttapohja: © [OpenStreetMapin](https://www.openstreetmap.org/copyright) tekijät
- [Leaflet](https://leafletjs.com/) (BSD-2-Clause)
