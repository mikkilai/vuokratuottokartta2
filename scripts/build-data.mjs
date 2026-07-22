#!/usr/bin/env node
/**
 * Hakee Tilastokeskuksen avoimen datan ja rakentaa data/areas.geojson:
 *
 *   1. Paavo-postinumeroalueet (rajat + väkiluku + mediaanitulot)
 *      geo.stat.fi WFS -rajapinnasta
 *   2. Vanhojen osakeasuntojen neliöhinnat postinumeroalueittain (StatFin/ashi)
 *   3. Vapaarahoitteisten vuokra-asuntojen keskineliövuokrat
 *      postinumeroalueittain (StatFin/asvu)
 *
 * Käyttö:  node scripts/build-data.mjs
 * Vaatii: Node 18+ (global fetch) ja verkkoyhteyden.
 *
 * Lähteet: Tilastokeskus, CC BY 4.0. Toteutuneet kaupat ja vuokrat,
 * ei pyyntihintoja.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ *
 * Asetukset. Jos StatFin-taulukoiden tunnukset muuttuvat, päivitä ne
 * tähän — skripti tulostaa virhetilanteessa saatavilla olevat taulukot.
 * ------------------------------------------------------------------ */
const CONFIG = {
  wfsUrl:
    "https://geo.stat.fi/geoserver/postialue/wfs" +
    "?service=WFS&version=2.0.0&request=GetFeature" +
    "&typeName=postialue:pno_tilasto" +
    "&outputFormat=application/json&srsName=EPSG:4326" +
    "&propertyName=posti_alue,nimi,kunta,he_vakiy,hr_mtu,geom",
  pxwebBase: "https://pxdata.stat.fi/PxWeb/api/v1/fi/StatFin",
  // Vanhojen osakeasuntojen neliöhinnat postinumeroalueittain (13mu, vuositaulukko).
  // Tunnuskandidaatit kokeillaan järjestyksessä; StatFin lyhensi tunnuksia 6/2026.
  priceDb: "ashi",
  priceTables: ["statfin_ashi_pxt_13mu.px", "13mu.px", "13mu"],
  priceTableTextRegex: /neli[öo]hinnat.*postinumero/i,
  priceMeasureRegex: /neli[öo]hinta|keskihinta|eur\/m2|€\/m2/i,
  // Vapaarahoitteisten vuokra-asuntojen keskineliövuokrat postinumeroalueittain
  // (13eb, neljännesvuosittain).
  rentDb: "asvu",
  rentTables: ["statfin_asvu_pxt_13eb.px", "13eb.px", "13eb"],
  rentTableTextRegex: /(keskineli[öo]vuokrat|vuokr).*postinumero/i,
  rentMeasureRegex: /neli[öo]vuokra|keskivuokra|eur\/m2|€\/m2/i,
  // Geometrian yksinkertaistus (asteina, ~0.0008° ≈ 60 m).
  simplifyTolerance: 0.0008,
  coordDecimals: 4,
};

/* ------------------------- Apufunktiot --------------------------- */

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

/** Tulostaa tietokannan taulukot, jos asetettua taulukkoa ei löydy. */
async function listTables(db) {
  try {
    const items = await getJson(`${CONFIG.pxwebBase}/${db}`);
    console.error(`\nTietokannan "${db}" taulukot:`);
    for (const it of items) console.error(`  ${it.id}  ${it.text}`);
  } catch {
    console.error(`(Tietokannan ${db} listaus epäonnistui.)`);
  }
}

/**
 * Etsii toimivan taulukon: kokeilee tunnuskandidaatit järjestyksessä ja
 * viimeisenä keinona hakee tietokannan taulukkolistan ja poimii sieltä
 * kuvaustekstiin täsmäävän taulukon (kestää StatFinin tunnusmuutokset).
 */
async function resolveTable(db, candidates, tableTextRegex, label) {
  const errors = [];
  for (const table of candidates) {
    const url = `${CONFIG.pxwebBase}/${db}/${table}`;
    try {
      const meta = await getJson(url);
      if (meta?.variables) return { url, meta };
    } catch (err) {
      errors.push(err.message.split("\n")[0]);
    }
  }
  try {
    const listing = await getJson(`${CONFIG.pxwebBase}/${db}`);
    const hits = (listing || []).filter((it) => it?.id && tableTextRegex.test(it.text || ""));
    for (const hit of hits) {
      const ids = /\.px$/i.test(hit.id) ? [hit.id] : [hit.id, `${hit.id}.px`];
      for (const id of ids) {
        const url = `${CONFIG.pxwebBase}/${db}/${id}`;
        try {
          const meta = await getJson(url);
          if (meta?.variables) return { url, meta };
        } catch { /* kokeile seuraavaa */ }
      }
    }
  } catch (err) {
    errors.push(err.message.split("\n")[0]);
  }
  console.error(`\nVIRHE: taulukkoa ei löytynyt (${label}): ${errors.join("; ")}`);
  await listTables(db);
  throw new Error(
    `Päivitä oikea taulukkotunnus tiedoston scripts/build-data.mjs CONFIG-osioon.`
  );
}

/**
 * Hakee PxWeb-taulukosta uusimman ajanjakson arvot postinumeroittain.
 * Palauttaa Map: postinumero -> arvo (€/m²).
 */
async function fetchPxTable(db, candidates, measureRegex, tableTextRegex, label) {
  const { url, meta } = await resolveTable(db, candidates, tableTextRegex, label);

  // Etsi ulottuvuudet nimen perusteella.
  const dims = meta.variables;
  const postiDim = dims.find((d) => /postinumero/i.test(d.text) || /postinumero/i.test(d.code));
  const timeDim = dims.find(
    (d) => d.time === true || /vuosi|neljännes|kuukausi/i.test(d.text) || /vuosi|nelj/i.test(d.code)
  );
  const infoDim = dims.find((d) => /tiedot/i.test(d.text) || /^tiedot$/i.test(d.code));
  if (!postiDim || !timeDim || !infoDim) {
    throw new Error(
      `Taulukon ulottuvuuksia ei tunnistettu (${label}): ` +
        dims.map((d) => `${d.code} (${d.text})`).join(", ")
    );
  }

  const latest = timeDim.values[timeDim.values.length - 1];
  const measureIdx = infoDim.valueTexts.findIndex((t) => measureRegex.test(t));
  if (measureIdx < 0) {
    throw new Error(
      `Tunnuslukua ei löytynyt (${label}) /${measureRegex.source}/. ` +
        `Saatavilla: ${infoDim.valueTexts.join("; ")}`
    );
  }
  console.log(
    `  ${label}: ${url.split("/").pop()}, jakso ${latest}, tunnusluku "${infoDim.valueTexts[measureIdx]}"`
  );

  const query = [
    { code: postiDim.code, selection: { filter: "all", values: ["*"] } },
    { code: timeDim.code, selection: { filter: "item", values: [latest] } },
    { code: infoDim.code, selection: { filter: "item", values: [infoDim.values[measureIdx]] } },
  ];
  // Muut ulottuvuudet (esim. Talotyyppi, Huoneluku): valitaan "yhteensä"-luokka,
  // jos sellainen on; muuten jätetään pois (PxWeb eliminoi ulottuvuuden).
  for (const d of dims) {
    if (d === postiDim || d === timeDim || d === infoDim) continue;
    const totalIdx = (d.valueTexts || []).findIndex((t) => /yhteensä|kaikki/i.test(t));
    if (totalIdx >= 0) {
      query.push({ code: d.code, selection: { filter: "item", values: [d.values[totalIdx]] } });
    }
  }

  const stat = await getJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, response: { format: "json-stat2" } }),
  });

  return parseJsonStat2(stat, postiDim.code);
}

/** Poimii json-stat2-vastauksesta Map: postinumerokoodi -> arvo. */
function parseJsonStat2(stat, postiCode) {
  const dimId = stat.id.find((id) => id === postiCode) ??
    stat.id.find((id) => /postinumero/i.test(id));
  const dim = stat.dimension[dimId];
  const codes = Object.keys(dim.category.index)
    .sort((a, b) => dim.category.index[a] - dim.category.index[b]);

  // Askel, jolla postinumeroulottuvuus etenee value-taulukossa.
  const order = stat.id;
  const sizes = stat.size;
  const pos = order.indexOf(dimId);
  let step = 1;
  for (let i = pos + 1; i < order.length; i++) step *= sizes[i];

  const out = new Map();
  codes.forEach((code, i) => {
    const v = stat.value[i * step];
    if (v !== null && v !== undefined && isFinite(v)) {
      // Koodit voivat olla muotoa "00100" tai "MK01 00100" — poimi numero-osa.
      const m = String(code).match(/\d{5}/);
      if (m) out.set(m[0], v);
    }
  });
  return out;
}

/* --------------------- Geometrian käsittely ---------------------- */

/** Ramer–Douglas–Peucker yhdelle renkaalle. */
function simplifyRing(ring, tol) {
  if (ring.length <= 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxDist = 0;
    let idx = -1;
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d;
      if (len2 === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 4 ? out : ring;
}

function roundCoord(c, decimals) {
  const f = 10 ** decimals;
  return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
}

function simplifyGeometry(geom) {
  const tol = CONFIG.simplifyTolerance;
  const dec = CONFIG.coordDecimals;
  const doRing = (ring) => simplifyRing(ring, tol).map((c) => roundCoord(c, dec));
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: geom.coordinates.map(doRing) };
  }
  if (geom.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geom.coordinates.map((poly) => poly.map(doRing)),
    };
  }
  return geom;
}

/* ----------------------------- Ajo ------------------------------- */

async function main() {
  console.log("1/3 Haetaan Paavo-postinumeroalueet (geo.stat.fi)…");
  const paavo = await getJson(CONFIG.wfsUrl);
  console.log(`  ${paavo.features.length} aluetta.`);

  console.log("2/3 Haetaan StatFin-tilastot (pxdata.stat.fi)…");
  const prices = await fetchPxTable(
    CONFIG.priceDb, CONFIG.priceTables, CONFIG.priceMeasureRegex,
    CONFIG.priceTableTextRegex, "neliöhinnat");
  const rents = await fetchPxTable(
    CONFIG.rentDb, CONFIG.rentTables, CONFIG.rentMeasureRegex,
    CONFIG.rentTableTextRegex, "keskivuokrat");
  console.log(`  hintoja ${prices.size} alueelle, vuokria ${rents.size} alueelle.`);

  console.log("3/3 Yhdistetään ja yksinkertaistetaan geometria…");
  let withBoth = 0;
  const features = paavo.features.map((f) => {
    const p = f.properties;
    const code = String(p.posti_alue).padStart(5, "0");
    const hinta = prices.get(code) ?? null;
    const vuokra = rents.get(code) ?? null;
    if (hinta !== null && vuokra !== null) withBoth++;
    return {
      type: "Feature",
      properties: {
        posti_alue: code,
        nimi: p.nimi || "",
        kunta: p.kunta || "",
        hinta_m2: hinta,
        vuokra_m2: vuokra,
        vakiluku: isFinite(p.he_vakiy) ? p.he_vakiy : null,
        mediaanitulo: isFinite(p.hr_mtu) ? p.hr_mtu : null,
      },
      geometry: simplifyGeometry(f.geometry),
    };
  });

  const out = {
    type: "FeatureCollection",
    metadata: {
      demo: false,
      generated: new Date().toISOString().slice(0, 10),
      sources: [
        "Tilastokeskus, Paavo-postinumeroalueet (CC BY 4.0)",
        "Tilastokeskus, StatFin 13mu (neliöhinnat postinumeroalueittain)",
        "Tilastokeskus, StatFin 13eb (keskineliövuokrat postinumeroalueittain)",
      ],
    },
    features,
  };

  mkdirSync(join(root, "data"), { recursive: true });
  const path = join(root, "data", "areas.geojson");
  const json = JSON.stringify(out);
  writeFileSync(path, json);
  console.log(
    `Valmis: ${path} (${(json.length / 1e6).toFixed(1)} Mt, ` +
    `${features.length} aluetta, ${withBoth} sekä hinta- että vuokratiedolla).`
  );
}

main().catch((err) => {
  console.error("\nEpäonnistui:", err.message);
  process.exit(1);
});
