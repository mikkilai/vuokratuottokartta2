#!/usr/bin/env node
/**
 * Rakentaa esilasketun aineiston data/areas.geojson ajamalla saman
 * hakulogiikan kuin selainsovellus (js/data.js): Paavo-postinumeroalueet,
 * StatFin-neliöhinnat ja -vuokrat, kauppa- ja havaintomäärät sekä
 * kuntatason täydennysarvot.
 *
 * Käyttö:  node scripts/build-data.mjs
 * Vaatii: Node 18+ (global fetch) ja verkkoyhteyden Tilastokeskuksen
 * rajapintoihin (geo.stat.fi, pxdata.stat.fi).
 *
 * Sovellus käyttää tämän tiedoston olemassa ollessa sitä ensisijaisena
 * lähteenä (metadata.demo === false), joten tämä skripti kannattaa ajaa
 * säännöllisesti — repossa on GitHub Actions -workflow, joka tekee sen
 * viikoittain.
 *
 * Lähteet: Tilastokeskus, CC BY 4.0. Toteutuneet kaupat ja vuokrat,
 * ei pyyntihintoja.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Lataa selainmoduuli sellaisenaan. VTKData ei käytä selain-API:ja
// buildLive-polulla (välimuisti on load()-polun takana), joten pelkkä
// window-stubi riittää.
const src = readFileSync(join(root, "js", "data.js"), "utf8");
const VTKData = new Function("window", src + "\nreturn VTKData;")({});

const data = await VTKData.buildLive((msg) => console.log(msg));

mkdirSync(join(root, "data"), { recursive: true });
const path = join(root, "data", "areas.geojson");
const json = JSON.stringify(data);
writeFileSync(path, json);

const withBoth = data.features.filter(
  (f) => f.properties.hinta_m2 !== null && f.properties.vuokra_m2 !== null
).length;
console.log(
  `Valmis: ${path} (${(json.length / 1e6).toFixed(1)} Mt, ` +
  `${data.features.length} aluetta, ${withBoth} postinumerotason hinta- ja vuokratiedolla).`
);
console.log(`Jaksot: hinnat ${data.metadata.priceYear}, vuokrat ${data.metadata.rentYear} (${data.metadata.rentLevel}-taso).`);
