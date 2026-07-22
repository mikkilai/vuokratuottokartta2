# Vuokratuottokartta

Vanhojen osakeasuntojen brutto- ja nettovuokratuotto postinumeroalueittain
koko Suomesta, kartalla.

**Miten se toimii:** klikkaat aluetta kartalta ja näet neliöhinnan,
keskineliövuokran, lasketun brutto- ja nettotuoton, kauppojen ja
vuokrahavaintojen määrän sekä taustatiedot (väkiluku, mediaanitulo).
Aluetta voi hakea postinumerolla tai paikannimellä, karttaa voi rajata
suodattimilla (bruttotuotto ja kauppamäärä vähintään), ja peitetyt alueet
täydennetään halutessa kuntatason keskiarvolla. Nettotuoton oletukset
(hoitovastike, vajaakäyttö, varainsiirtovero, pääomatulovero) saa säätää
itse. Kaikki data on Tilastokeskuksen virallista avointa dataa —
toteutuneita kauppoja, ei pyyntihintoja. Ei mainoksia, ei kirjautumista.

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

Latausjärjestys (`js/data.js`):

1. **Selaimen välimuisti** (Cache API, 7 vrk) — tyhjennys konsolissa
   `VTKData.clearCache()`.
2. **Esirakennettu `data/areas.geojson`**, jos se sisältää oikeaa dataa
   (`metadata.demo === false`). Tämä on ensisijainen lähde: nopea eikä
   riipu Tilastokeskuksen rajapinnan saatavuudesta. Tiedoston rakentaa
   `node scripts/build-data.mjs` (Node 18+), ja GitHub Actions -workflow
   (`.github/workflows/update-data.yml`) ajaa sen viikoittain ja
   committoi muutokset.
3. **Livehaku selaimessa** suoraan Tilastokeskuksen rajapinnoista
   (automaattinen varapolku).
4. **Demo-varatiedosto** (42 esimerkkialuetta, banneri kertoo tästä).

Haettavat aineistot:

- Paavo-postinumeroalueiden rajat, väkiluku ja mediaanitulot
  (`geo.stat.fi` WFS)
- Vanhojen osakeasuntojen neliöhinnat ja kauppojen lukumäärät
  postinumeroalueittain (StatFin/ashi 13mu) sekä neliöhinnat kunnittain
  (13mx) peitettyjen alueiden täydennykseen
- Keskineliövuokrat (StatFin/asvu): ensisijaisesti postinumerotasolla
  (aktiivinen tai arkistokanta), muuten kuntatasolla (15fa,
  viimeiset neljä neljännestä yhdistettynä)

Taulukot etsitään tunnuskandidaateilla ja tarvittaessa tietokannan
listauksesta, ja löydetyn taulukon rakenne tarkistetaan metadatasta —
tämä kestää StatFinin taulukkotunnusten muutokset (kuten kesäkuun 2026
lyhennyksen). Asetukset ovat `js/data.js`-tiedoston `CONFIG`-osiossa.
Geometria yksinkertaistetaan (Ramer–Douglas–Peucker) renderöinnin
keventämiseksi. Demo-varatiedoston generoi `node scripts/make-demo-data.mjs`.

## Laskentakaavat

- **Bruttotuotto** = (keskineliövuokra × 12) ÷ neliöhinta × 100 %
  — sekä hinta että vuokra ovat neliöperusteisia, joten asuntokokoa ei
  tarvitse olettaa
- **Nettotuotto** = ((vuokra × (1 − vajaakäyttö) − hoitovastike) × 12)
  ÷ (neliöhinta × (1 + varainsiirtovero)) × 100 %; halutessa
  positiivisesta nettotuotosta vähennetään lisäksi pääomatulovero

Oletukset (muutettavissa *Haku ja asetukset* -paneelista, tallentuvat
selaimen localStorageen):

| Oletus | Oletusarvo |
| --- | --- |
| Hoitovastike | 4,5 €/m²/kk |
| Vajaakäyttöaste | 5 % |
| Varainsiirtovero | 1,5 % |
| Pääomatulovero | pois päältä (30 % / 34 %) |

## Rakenne

```
index.html            Sovelluksen runko
css/style.css         Tyylit
js/data.js            Aineiston haku ja rakennus (Tilastokeskus)
js/app.js             Karttalogiikka, haku, suodattimet (vanilla JS + Leaflet)
vendor/leaflet/       Leaflet 1.9.4 (vendoroitu)
data/areas.geojson    Aineisto (esirakennettu tai demo-varatiedosto)
scripts/build-data.mjs     Esirakennetun aineiston tuottaminen (sama logiikka kuin selaimessa)
scripts/make-demo-data.mjs Demo-varatiedoston generointi
.github/workflows/update-data.yml  Viikoittainen aineistopäivitys
```

## Lisenssit

- Koodi: ks. [LICENSE](LICENSE)
- Tilastoaineisto: Tilastokeskus, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi)
- Karttapohja: © [OpenStreetMapin](https://www.openstreetmap.org/copyright) tekijät
- [Leaflet](https://leafletjs.com/) (BSD-2-Clause)
