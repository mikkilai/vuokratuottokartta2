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

Aineisto haetaan ja rakennetaan **selaimessa sivun auetessa** suoraan
Tilastokeskuksen avoimista rajapinnoista (`js/data.js`):

1. Paavo-postinumeroalueiden rajat, väkiluku ja mediaanitulot
   WFS-rajapinnasta (`geo.stat.fi`),
2. vanhojen osakeasuntojen neliöhinnat (StatFin/ashi) ja
   vapaarahoitteisten vuokra-asuntojen keskineliövuokrat (StatFin/asvu)
   postinumeroalueittain uusimmalta tilastovuodelta (`pxdata.stat.fi`),
3. aineistot yhdistetään postinumerolla ja geometria yksinkertaistetaan
   (Ramer–Douglas–Peucker) renderöinnin keventämiseksi.

Valmis aineisto tallennetaan selaimen Cache API -välimuistiin
seitsemäksi vuorokaudeksi, joten raskas haku tehdään vain kerran.
Välimuistin voi tyhjentää selaimen konsolissa: `VTKData.clearCache()`.

Jos haku epäonnistuu (ei verkkoa, rajapinta nurin), sovellus näyttää
repossa olevan varatiedoston `data/areas.geojson` (42 suuntaa-antavaa
demoaluetta) ja kertoo siitä bannerissa.

StatFin-taulukoiden tunnukset on määritelty `js/data.js`-tiedoston
`CONFIG`-osiossa.

Saman aineiston voi rakentaa myös etukäteen komennolla
`node scripts/build-data.mjs` (Node 18+), joka kirjoittaa
`data/areas.geojson`-varatiedoston; demoversion generoi
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
js/data.js            Aineiston haku ja rakennus selaimessa (Tilastokeskus)
js/app.js             Karttalogiikka (vanilla JS + Leaflet)
vendor/leaflet/       Leaflet 1.9.4 (vendoroitu)
data/areas.geojson    Varatiedosto, jos livehaku epäonnistuu (demo)
scripts/build-data.mjs     Aineiston rakennus etukäteen (valinnainen)
scripts/make-demo-data.mjs Demo-varatiedoston generointi
```

## Lisenssit

- Koodi: ks. [LICENSE](LICENSE)
- Tilastoaineisto: Tilastokeskus, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi)
- Karttapohja: © [OpenStreetMapin](https://www.openstreetmap.org/copyright) tekijät
- [Leaflet](https://leafletjs.com/) (BSD-2-Clause)
