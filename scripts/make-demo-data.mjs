#!/usr/bin/env node
/**
 * Luo demo-datan (data/areas.geojson), jotta sovellus toimii heti ilman
 * verkkoyhteyttä. Oikea, koko Suomen kattava aineisto haetaan ajamalla
 * scripts/build-data.mjs (vaatii verkkoyhteyden Tilastokeskuksen rajapintoihin).
 *
 * Luvut ovat suuntaa-antavia arvioita todellisista tasoista (eivät virallista
 * tilastoa) ja aluerajat ovat keinotekoisia monikulmioita kaupunkien ympärillä.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// [posti_alue, nimi, kunta, lat, lon, hinta €/m², vuokra €/m²/kk, väkiluku, mediaanitulo €/v]
const AREAS = [
  ["00100", "Helsinki keskusta", "Helsinki", 60.170, 24.941, 7800, 25.5, 18500, 31900],
  ["00530", "Kallio", "Helsinki", 60.184, 24.950, 6300, 24.0, 15200, 28400],
  ["00200", "Lauttasaari", "Helsinki", 60.158, 24.879, 6600, 22.5, 24100, 33800],
  ["00700", "Malmi", "Helsinki", 60.251, 25.010, 3300, 18.5, 12900, 24900],
  ["00980", "Vuosaari itäinen", "Helsinki", 60.209, 25.147, 3500, 18.0, 15800, 24100],
  ["02100", "Tapiola", "Espoo", 60.175, 24.805, 5400, 21.0, 10400, 32300],
  ["02600", "Leppävaara", "Espoo", 60.219, 24.813, 4800, 20.5, 14700, 29800],
  ["01300", "Tikkurila", "Vantaa", 60.292, 25.044, 3600, 19.0, 14300, 26300],
  ["01600", "Myyrmäki", "Vantaa", 60.261, 24.854, 3400, 18.5, 15900, 25200],
  ["04400", "Järvenpää keskus", "Järvenpää", 60.474, 25.090, 3000, 16.5, 12800, 26800],
  ["05800", "Hyvinkää keskus", "Hyvinkää", 60.631, 24.858, 2500, 15.5, 11900, 25700],
  ["06100", "Porvoo keskus", "Porvoo", 60.395, 25.663, 3100, 16.0, 12600, 26400],
  ["08100", "Lohja keskus", "Lohja", 60.250, 24.065, 2200, 14.0, 9800, 24800],
  ["11100", "Riihimäki keskus", "Riihimäki", 60.737, 24.772, 2000, 14.0, 9200, 24600],
  ["13100", "Hämeenlinna keskus", "Hämeenlinna", 60.996, 24.464, 2400, 15.0, 10700, 25100],
  ["15100", "Lahti asemanseutu", "Lahti", 60.981, 25.655, 2600, 15.5, 8900, 23900],
  ["18100", "Heinola kirkonkylä", "Heinola", 61.204, 26.038, 1400, 12.0, 7600, 22800],
  ["20100", "Turku keskusta", "Turku", 60.452, 22.267, 4100, 18.0, 16700, 24500],
  ["20520", "Kupittaa", "Turku", 60.450, 22.298, 3600, 17.5, 9800, 24900],
  ["21200", "Raisio keskus", "Raisio", 60.486, 22.169, 2300, 14.5, 10900, 25600],
  ["24100", "Salo keskus", "Salo", 60.384, 23.126, 1600, 13.0, 10200, 23700],
  ["26100", "Rauma keskus", "Rauma", 61.128, 21.511, 2200, 13.5, 9400, 25000],
  ["28100", "Pori keskus", "Pori", 61.485, 21.797, 2100, 13.5, 10100, 23400],
  ["33100", "Tampere keskusta", "Tampere", 61.497, 23.760, 4600, 19.5, 15300, 24800],
  ["33500", "Kaleva", "Tampere", 61.502, 23.798, 3800, 17.5, 12700, 24300],
  ["33720", "Hervanta", "Tampere", 61.451, 23.851, 2900, 16.5, 21800, 20900],
  ["40100", "Jyväskylä keskusta", "Jyväskylä", 62.243, 25.747, 3400, 17.0, 13900, 22600],
  ["45100", "Kouvola keskus", "Kouvola", 60.868, 26.704, 1700, 12.5, 9500, 23200],
  ["48100", "Kotka keskus", "Kotka", 60.466, 26.941, 1800, 13.0, 8700, 22700],
  ["50100", "Mikkeli keskus", "Mikkeli", 61.688, 27.273, 2200, 14.0, 9900, 23800],
  ["53100", "Lappeenranta keskus", "Lappeenranta", 61.058, 28.187, 2400, 14.5, 10600, 23900],
  ["57100", "Savonlinna keskus", "Savonlinna", 61.868, 28.879, 1600, 12.5, 7800, 22400],
  ["60100", "Seinäjoki keskus", "Seinäjoki", 62.787, 22.850, 2600, 14.5, 11800, 25200],
  ["65100", "Vaasa keskus", "Vaasa", 63.096, 21.616, 2900, 15.0, 12400, 24700],
  ["67100", "Kokkola keskus", "Kokkola", 63.838, 23.132, 2400, 14.0, 10300, 24600],
  ["70100", "Kuopio keskus", "Kuopio", 62.892, 27.677, 3500, 16.5, 12100, 24200],
  ["78200", "Varkaus keskus", "Varkaus", 62.314, 27.873, 900, 11.0, 6800, 21900],
  ["80100", "Joensuu keskus", "Joensuu", 62.601, 29.763, 2700, 15.0, 11400, 22800],
  ["87100", "Kajaani keskus", "Kajaani", 64.222, 27.728, 1500, 12.0, 8200, 22900],
  ["90100", "Oulu keskusta", "Oulu", 65.012, 25.471, 3200, 16.0, 14600, 23600],
  ["94100", "Kemi keskus", "Kemi", 65.736, 24.564, 1100, 11.5, 7100, 22300],
  ["96100", "Rovaniemi keskus", "Rovaniemi", 66.498, 25.721, 3000, 15.5, 11700, 23700],
];

// Deterministinen satunnaislukugeneraattori, jotta demo-monikulmiot pysyvät samoina.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Epäsäännöllinen "blobi" keskipisteen ympärille (WGS84-asteina).
function blob(lat, lon, seed) {
  const rnd = mulberry32(seed);
  const n = 14;
  const baseKm = 1.6 + rnd() * 1.2;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const rKm = baseKm * (0.7 + rnd() * 0.6);
    const dLat = (rKm / 111) * Math.sin(a);
    const dLon = ((rKm / 111) * Math.cos(a)) / Math.cos((lat * Math.PI) / 180);
    ring.push([+(lon + dLon).toFixed(4), +(lat + dLat).toFixed(4)]);
  }
  ring.push(ring[0]);
  return [ring];
}

const features = AREAS.map(([posti, nimi, kunta, lat, lon, hinta, vuokra, vakiluku, tulo], i) => ({
  type: "Feature",
  properties: {
    posti_alue: posti,
    nimi,
    kunta,
    hinta_m2: hinta,
    vuokra_m2: vuokra,
    // Karkeat demomäärät väkiluvusta johdettuna.
    kaupat: Math.round(vakiluku / 150),
    havainnot: Math.round(vakiluku / 60),
    kunta_hinta_m2: Math.round(hinta * 0.85),
    kunta_vuokra_m2: Math.round(vuokra * 0.92 * 10) / 10,
    vakiluku,
    mediaanitulo: tulo,
  },
  geometry: { type: "Polygon", coordinates: blob(lat, lon, 1000 + i) },
}));

const out = {
  type: "FeatureCollection",
  metadata: {
    demo: true,
    generated: new Date().toISOString().slice(0, 10),
    note:
      "DEMO-AINEISTO: suuntaa-antavat arviot, ei virallista tilastoa. " +
      "Aja scripts/build-data.mjs hakeaksesi Tilastokeskuksen avoimen datan.",
  },
  features,
};

mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "areas.geojson"), JSON.stringify(out));
console.log(`Kirjoitettu data/areas.geojson (${features.length} demoaluetta)`);
