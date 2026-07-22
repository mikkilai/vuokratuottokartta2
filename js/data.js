/* Vuokratuottokartta — aineiston haku ja rakennus selaimessa.
 *
 * Sivun auetessa haetaan suoraan Tilastokeskuksen avoimista rajapinnoista:
 *   1. Paavo-postinumeroalueet (rajat + väkiluku + mediaanitulot), geo.stat.fi WFS
 *   2. Vanhojen osakeasuntojen neliöhinnat postinumeroalueittain, StatFin/ashi
 *   3. Keskineliövuokrat, StatFin/asvu — ensisijaisesti postinumerotasolla
 *      (aktiivinen tai arkistokanta StatFin_Passiivi), muuten kuntatasolla
 *      (taulukko 15fa), jolloin vuokra liitetään postinumeroalueeseen
 *      Paavo-aineiston kuntakoodilla
 *
 * Tilastokeskus uudisti vuokratilaston 2026: postinumerotason taulukko 13eb
 * poistui ja tilalle tuli aluetason 15fa. Taulukot etsitään siksi
 * kandidaattilistoilla ja tietokantalistauksista, ja löydetyn taulukon
 * ulottuvuudet tarkistetaan metadatasta ennen käyttöä.
 *
 * Valmis aineisto tallennetaan selaimen Cache API -välimuistiin (7 vrk).
 * Jos haku epäonnistuu, käytetään repossa olevaa data/areas.geojson-varatiedostoa.
 */
var VTKData = (function () {
  "use strict";

  var CONFIG = {
    wfsUrl:
      "https://geo.stat.fi/geoserver/postialue/wfs" +
      "?service=WFS&version=2.0.0&request=GetFeature" +
      "&typeName=postialue:pno_tilasto" +
      "&outputFormat=application/json&srsName=EPSG:4326" +
      "&propertyName=posti_alue,nimi,kunta,he_vakiy,hr_mtu,geom",
    // PxWeb-rajapinnan juuri; tietokantapolut sen alle.
    pxwebBase: "https://pxdata.stat.fi/PxWeb/api/v1/fi",
    priceDb: "StatFin/ashi",
    rentDb: "StatFin/asvu",
    rentDbArchive: "StatFin_Passiivi/asvu",

    // Vanhojen osakeasuntojen neliöhinnat postinumeroalueittain (13mu).
    priceTables: ["statfin_ashi_pxt_13mu.px", "13mu.px", "13mu"],
    priceTableTextRegex: /neli[öo]hinnat.*postinumero/i,
    priceMeasureRegex: /neli[öo]hinta|keskihinta|eur\/m2|€\/m2/i,
    // Kauppojen lukumäärä samasta 13mu-taulukosta (kauppasuodatinta varten).
    countMeasureRegex: /lukumäär|kauppo/i,
    // Neliöhinnat kunnittain (13mx) peitettyjen alueiden täydennykseen.
    kuntaPriceTables: ["statfin_ashi_pxt_13mx.px", "13mx.px", "13mx"],
    kuntaPriceTextRegex: /neli[öo]hinnat.*kunnittain/i,

    // Keskineliövuokrat postinumerotasolla (13eb; poistunut aktiivikannasta,
    // mahdollisesti arkistossa nimellä statfinpas_asvu_pxt_13eb_*).
    rentTables: ["statfin_asvu_pxt_13eb.px", "13eb.px", "13eb"],
    rentTableTextRegex: /keskineli[öo]vuokr|vuokr/i,
    rentArchiveTextRegex: /13eb|keskineli[öo]vuokr.*postinumero/i,
    // Keskineliövuokrat aluetasolla (15fa: vuokraindeksi ja keskineliövuokrat).
    rentAreaTables: ["statfin_asvu_pxt_15fa.px", "15fa.px", "15fa"],
    rentAreaTextRegex: /vuokraindeksi|keskineli[öo]vuokr/i,
    rentMeasureRegex: /neli[öo]vuokra|keskivuokra|eur\/m2|€\/m2/i,

    // Geometrian yksinkertaistus renderöinnin keventämiseksi (~60 m).
    simplifyTolerance: 0.0008,
    coordDecimals: 4,
    cacheName: "vtk-data-v2",
    cacheUrl: "/__vtk__/areas.json",
    cacheMaxAgeMs: 7 * 24 * 3600 * 1000,
    fallbackUrl: "data/areas.geojson",
  };

  var POSTAL_DIM = /postinumero/i;
  var AREA_DIM = /alue|kunta/i;
  var TIME_DIM = /vuosi|neljännes|kuukausi/i;

  /* ------------------------- Haku ------------------------- */

  async function getJson(url, options) {
    var res = await fetch(url, options);
    if (!res.ok) throw new Error("HTTP " + res.status + " (" + url.split("?")[0] + ")");
    return res.json();
  }

  /** Lataa ison JSON-vastauksen ja raportoi edistymisen tavuina. */
  async function getJsonWithProgress(url, onBytes) {
    var res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status + " (" + url.split("?")[0] + ")");
    if (!res.body || !res.body.getReader) return res.json();
    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      received += r.value.length;
      if (onBytes) onBytes(received);
    }
    return JSON.parse(await new Blob(chunks).text());
  }

  function hasDim(meta, regex) {
    return (meta.variables || []).some(function (d) {
      return regex.test(d.text || "") || regex.test(d.code || "");
    });
  }

  /**
   * Etsii toimivan taulukon: kokeilee tunnuskandidaatit järjestyksessä ja
   * viimeisenä keinona käy tietokannan taulukkolistan läpi kuvaustekstin
   * perusteella. Löydetyn taulukon metadatasta tarkistetaan, että vaadittu
   * ulottuvuus (esim. Postinumero) on olemassa — pelkkä nimi ei riitä,
   * koska StatFin nimeää taulukot uudelleen. Palauttaa { url, meta }.
   */
  async function resolveTable(db, candidates, tableTextRegex, requireDim, label) {
    var errors = [];
    var tryUrl = async function (url) {
      var meta = await getJson(url);
      if (!meta || !meta.variables) throw new Error("ei metadataa");
      if (requireDim && !hasDim(meta, requireDim)) throw new Error("väärä rakenne");
      return { url: url, meta: meta };
    };

    for (var i = 0; i < candidates.length; i++) {
      try {
        return await tryUrl(CONFIG.pxwebBase + "/" + db + "/" + candidates[i]);
      } catch (e) {
        errors.push(candidates[i] + ": " + e.message);
      }
    }
    // Kandidaatit eivät toimineet — etsi tietokannan listauksesta.
    try {
      var listing = await getJson(CONFIG.pxwebBase + "/" + db);
      var hits = (listing || []).filter(function (it) {
        return it && it.id && tableTextRegex.test(it.text || "");
      });
      for (var j = 0; j < hits.length; j++) {
        var ids = [hits[j].id];
        if (!/\.px$/i.test(hits[j].id)) ids.push(hits[j].id + ".px");
        for (var k = 0; k < ids.length; k++) {
          try {
            return await tryUrl(CONFIG.pxwebBase + "/" + db + "/" + ids[k]);
          } catch (e) { /* kokeile seuraavaa */ }
        }
      }
    } catch (e) {
      errors.push(e.message);
    }
    throw new Error("Taulukkoa ei löytynyt (" + label + "): " + errors.join("; "));
  }

  /**
   * Hakee taulukosta uusimman ajanjakson arvot alueittain.
   * geoRegex määrää, mikä ulottuvuus on alue (Postinumero tai Alue/Kunta).
   * Palauttaa { values, year, measureText, table }.
   */
  async function fetchPxTable(db, candidates, measureRegex, tableTextRegex, geoRegex, label) {
    var resolved = await resolveTable(db, candidates, tableTextRegex, geoRegex, label);
    var url = resolved.url;
    var dims = resolved.meta.variables;

    var infoDim = dims.find(function (d) { return /tiedot/i.test(d.text) || /^tiedot$/i.test(d.code); });
    var timeDim = dims.find(function (d) {
      return d.time === true || TIME_DIM.test(d.text || "") || TIME_DIM.test(d.code || "");
    });
    var geoDim = dims.find(function (d) {
      return d !== timeDim && d !== infoDim &&
        (geoRegex.test(d.text || "") || geoRegex.test(d.code || ""));
    });
    if (!geoDim || !timeDim || !infoDim) {
      throw new Error("Taulukon ulottuvuuksia ei tunnistettu (" + label + ")");
    }

    // Neljännesvuositaulukoista yhdistetään viimeiset neljä neljännestä
    // (keskiarvo), vuositaulukoista poimitaan uusin vuosi.
    var timeValues;
    var quarterly = timeDim.values.some(function (v) { return /q/i.test(v); });
    if (quarterly) {
      timeValues = timeDim.values.slice(-4);
    } else {
      timeValues = [timeDim.values[timeDim.values.length - 1]];
    }
    var periodLabel = timeValues.length > 1
      ? timeValues[0] + "–" + timeValues[timeValues.length - 1]
      : timeValues[0];

    var measureIdx = infoDim.valueTexts.findIndex(function (t) { return measureRegex.test(t); });
    if (measureIdx < 0) {
      throw new Error("Tunnuslukua ei löytynyt (" + label + "). Saatavilla: " + infoDim.valueTexts.join("; "));
    }

    var query = [
      { code: geoDim.code, selection: { filter: "all", values: ["*"] } },
      { code: timeDim.code, selection: { filter: "item", values: timeValues } },
      { code: infoDim.code, selection: { filter: "item", values: [infoDim.values[measureIdx]] } },
    ];
    // Muut ulottuvuudet (esim. Talotyyppi, Huoneluku): valitaan "yhteensä"-luokka,
    // jos sellainen on; muuten jätetään pois (PxWeb eliminoi ulottuvuuden).
    dims.forEach(function (d) {
      if (d === geoDim || d === timeDim || d === infoDim) return;
      var totalIdx = (d.valueTexts || []).findIndex(function (t) { return /yhteensä|kaikki/i.test(t); });
      if (totalIdx >= 0) {
        query.push({ code: d.code, selection: { filter: "item", values: [d.values[totalIdx]] } });
      }
    });

    var stat = await getJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, response: { format: "json-stat2" } }),
    });

    return {
      values: parseJsonStat2(stat, geoDim.code),
      year: periodLabel,
      measureText: infoDim.valueTexts[measureIdx],
      table: url.split("/").pop(),
      db: db,
      geoRegex: geoRegex,
      tableTextRegex: tableTextRegex,
    };
  }

  /**
   * Poimii json-stat2-vastauksesta Map: aluekoodi -> arvo. Jos alueelle on
   * useita arvoja (esim. neljä vuosineljännestä), niistä lasketaan
   * keskiarvo. Jokainen arvo tallennetaan usealla avaimella (raakakoodi,
   * koodin numero-osa, pienaakkosin kirjoitettu nimi), jotta liitos
   * onnistuu riippumatta siitä, missä muodossa koodit ovat.
   */
  function parseJsonStat2(stat, geoCode) {
    var dimId = stat.id.indexOf(geoCode) >= 0 ? geoCode :
      stat.id.find(function (id) { return POSTAL_DIM.test(id) || AREA_DIM.test(id); });
    var dim = stat.dimension[dimId];
    var labels = (dim.category && dim.category.label) || {};
    var codes = Object.keys(dim.category.index).sort(function (a, b) {
      return dim.category.index[a] - dim.category.index[b];
    });

    var pos = stat.id.indexOf(dimId);
    var after = 1;
    for (var i = pos + 1; i < stat.id.length; i++) after *= stat.size[i];
    var before = 1;
    for (var j = 0; j < pos; j++) before *= stat.size[j];
    var geoSize = stat.size[pos];

    var out = new Map();
    codes.forEach(function (code, idx) {
      // Kerää kaikki tämän alueen arvot (muut ulottuvuudet, esim. neljännekset).
      var sum = 0;
      var n = 0;
      for (var b = 0; b < before; b++) {
        var base = (b * geoSize + idx) * after;
        for (var k = 0; k < after; k++) {
          var v = stat.value[base + k];
          if (v !== null && v !== undefined && isFinite(v)) { sum += v; n++; }
        }
      }
      if (n === 0) return;
      var mean = sum / n;
      var raw = String(code).trim();
      out.set(raw, mean);
      var digits = raw.match(/(\d{3,5})\s*$/);
      if (digits) out.set(digits[1], mean);
      if (labels[code]) out.set(String(labels[code]).trim().toLowerCase(), mean);
    });
    return out;
  }

  /**
   * Hakee keskivuokrat parhaalla saatavilla olevalla tasolla:
   * postinumerotaso (aktiivinen tai arkisto) tai kuntataso (15fa).
   * Palauttaa fetchPxTablen tuloksen + { level: "postinumero"|"kunta" }.
   */
  async function fetchRents() {
    var errors = [];
    var postalSources = [
      { db: CONFIG.rentDb, candidates: CONFIG.rentTables, textRegex: CONFIG.rentTableTextRegex },
      { db: CONFIG.rentDbArchive, candidates: [], textRegex: CONFIG.rentArchiveTextRegex },
    ];
    for (var i = 0; i < postalSources.length; i++) {
      var src = postalSources[i];
      try {
        var t = await fetchPxTable(
          src.db, src.candidates, CONFIG.rentMeasureRegex, src.textRegex,
          POSTAL_DIM, "keskivuokrat");
        t.level = "postinumero";
        return t;
      } catch (e) {
        errors.push(e.message);
      }
    }
    try {
      var t2 = await fetchPxTable(
        CONFIG.rentDb, CONFIG.rentAreaTables, CONFIG.rentMeasureRegex,
        CONFIG.rentAreaTextRegex, AREA_DIM, "keskivuokrat, kuntataso");
      t2.level = "kunta";
      return t2;
    } catch (e) {
      errors.push(e.message);
      throw new Error("Vuokratietoja ei saatu: " + errors.join(" | "));
    }
  }

  /* --------------- Geometrian yksinkertaistus --------------- */

  function simplifyRing(ring, tol) {
    if (ring.length <= 5) return ring;
    var keep = new Uint8Array(ring.length);
    keep[0] = keep[ring.length - 1] = 1;
    var stack = [[0, ring.length - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var a = seg[0], b = seg[1];
      var maxDist = 0, idx = -1;
      var ax = ring[a][0], ay = ring[a][1];
      var bx = ring[b][0], by = ring[b][1];
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      for (var i = a + 1; i < b; i++) {
        var px = ring[i][0], py = ring[i][1], d;
        if (len2 === 0) {
          d = Math.hypot(px - ax, py - ay);
        } else {
          var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }
        if (d > maxDist) { maxDist = d; idx = i; }
      }
      if (maxDist > tol) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    var out = [];
    for (var j = 0; j < ring.length; j++) if (keep[j]) out.push(ring[j]);
    return out.length >= 4 ? out : ring;
  }

  function roundCoord(c, decimals) {
    var f = Math.pow(10, decimals);
    return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
  }

  function simplifyGeometry(geom) {
    var tol = CONFIG.simplifyTolerance;
    var dec = CONFIG.coordDecimals;
    var doRing = function (ring) {
      return simplifyRing(ring, tol).map(function (c) { return roundCoord(c, dec); });
    };
    if (geom.type === "Polygon") {
      return { type: "Polygon", coordinates: geom.coordinates.map(doRing) };
    }
    if (geom.type === "MultiPolygon") {
      return {
        type: "MultiPolygon",
        coordinates: geom.coordinates.map(function (poly) { return poly.map(doRing); }),
      };
    }
    return geom;
  }

  /* ----------------------- Rakennus ----------------------- */

  async function buildLive(onProgress) {
    var say = onProgress || function () {};

    say("Haetaan hinta- ja vuokratilastoja (Tilastokeskus)…");
    // Pakolliset: postinumerotason hinnat ja vuokrat (parhaalla tasolla).
    // Valinnaiset (null jos ei saada): kauppamäärät sekä kuntatason hinnat
    // ja vuokrat peitettyjen alueiden täydennykseen.
    var results = await Promise.all([
      fetchPxTable(CONFIG.priceDb, CONFIG.priceTables, CONFIG.priceMeasureRegex,
        CONFIG.priceTableTextRegex, POSTAL_DIM, "neliöhinnat"),
      fetchRents(),
      fetchPxTable(CONFIG.priceDb, CONFIG.priceTables, CONFIG.countMeasureRegex,
        CONFIG.priceTableTextRegex, POSTAL_DIM, "kauppamäärät")
        .catch(function () { return null; }),
      fetchPxTable(CONFIG.priceDb, CONFIG.kuntaPriceTables, CONFIG.priceMeasureRegex,
        CONFIG.kuntaPriceTextRegex, AREA_DIM, "neliöhinnat, kuntataso")
        .catch(function () { return null; }),
    ]);
    var prices = results[0];
    var rents = results[1];
    var counts = results[2];
    var kuntaPrices = results[3];

    // Vuokrahavaintojen lukumäärä samasta lähteestä kuin vuokrat (jos julkaistaan).
    var rentCounts = await fetchPxTable(rents.db, [rents.table],
      /lukumäär|havainto/i, rents.tableTextRegex, rents.geoRegex,
      "vuokrahavainnot").catch(function () { return null; });

    // Kuntatason vuokrat täydennykseen: jos vuokrat saatiin vain kuntatasolla,
    // sama aineisto kelpaa; muuten haetaan 15fa erikseen.
    var kuntaRents = rents.level === "kunta" ? rents :
      await fetchPxTable(CONFIG.rentDb, CONFIG.rentAreaTables, CONFIG.rentMeasureRegex,
        CONFIG.rentAreaTextRegex, AREA_DIM, "keskivuokrat, kuntataso")
        .catch(function () { return null; });

    say("Ladataan postinumeroalueiden rajoja…");
    var paavo = await getJsonWithProgress(CONFIG.wfsUrl, function (bytes) {
      say("Ladataan postinumeroalueiden rajoja… " + (bytes / 1e6).toFixed(1) + " Mt");
    });

    var kuntaLookup = function (table, kuntaCode) {
      if (!table) return null;
      var k = String(kuntaCode || "").replace(/\D/g, "");
      while (k.length > 0 && k.length < 3) k = "0" + k;
      return k && table.values.has(k) ? table.values.get(k) : null;
    };

    say("Rakennetaan karttaa…");
    var features = paavo.features.map(function (f) {
      var p = f.properties;
      var code = String(p.posti_alue);
      while (code.length < 5) code = "0" + code;
      return {
        type: "Feature",
        properties: {
          posti_alue: code,
          nimi: p.nimi || "",
          kunta: p.kunta || "",
          hinta_m2: prices.values.has(code) ? prices.values.get(code) : null,
          vuokra_m2: rents.level === "postinumero" && rents.values.has(code)
            ? rents.values.get(code) : null,
          kaupat: counts && counts.values.has(code)
            ? Math.round(counts.values.get(code)) : null,
          havainnot: rentCounts
            ? (rents.level === "postinumero"
                ? (rentCounts.values.has(code) ? Math.round(rentCounts.values.get(code)) : null)
                : (kuntaLookup(rentCounts, p.kunta) !== null
                    ? Math.round(kuntaLookup(rentCounts, p.kunta)) : null))
            : null,
          kunta_hinta_m2: kuntaLookup(kuntaPrices, p.kunta),
          kunta_vuokra_m2: kuntaLookup(kuntaRents, p.kunta),
          vakiluku: isFinite(p.he_vakiy) ? p.he_vakiy : null,
          mediaanitulo: isFinite(p.hr_mtu) ? p.hr_mtu : null,
        },
        geometry: simplifyGeometry(f.geometry),
      };
    });

    return {
      type: "FeatureCollection",
      metadata: {
        demo: false,
        generated: new Date().toISOString().slice(0, 10),
        priceYear: prices.year,
        rentYear: rents.year,
        rentLevel: rents.level,
        sources: [
          "Tilastokeskus, Paavo-postinumeroalueet (CC BY 4.0)",
          "Tilastokeskus, StatFin " + prices.table + " (" + prices.measureText + ")",
          "Tilastokeskus, StatFin " + rents.table + " (" + rents.measureText +
            (rents.level === "kunta" ? ", kuntataso" : "") + ")",
        ],
      },
      features: features,
    };
  }

  /* ---------------------- Välimuisti ---------------------- */

  async function readCache() {
    if (!("caches" in window)) return null;
    try {
      var cache = await caches.open(CONFIG.cacheName);
      var res = await cache.match(CONFIG.cacheUrl);
      if (!res) return null;
      var ts = Number(res.headers.get("x-vtk-generated") || 0);
      if (!ts || Date.now() - ts > CONFIG.cacheMaxAgeMs) return null;
      return res.json();
    } catch (e) {
      return null;
    }
  }

  async function writeCache(data) {
    if (!("caches" in window)) return;
    try {
      var cache = await caches.open(CONFIG.cacheName);
      await cache.put(
        CONFIG.cacheUrl,
        new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "x-vtk-generated": String(Date.now()),
          },
        })
      );
    } catch (e) { /* välimuisti täynnä tms. — ei haittaa */ }
  }

  /* ------------------------- API ------------------------- */

  /**
   * Palauttaa { data, source, error? }, jossa source on
   * "cache" | "static" | "live" | "fallback".
   *
   * Ensisijainen lähde on esirakennettu data/areas.geojson (jos se sisältää
   * oikeaa dataa, metadata.demo === false) — se latautuu nopeasti eikä riipu
   * Tilastokeskuksen rajapinnan saatavuudesta. Livehaku selaimessa on
   * automaattinen varapolku, ja demo-aineisto viimeinen varasisältö.
   */
  async function load(onProgress) {
    var say = onProgress || function () {};

    var cached = await readCache();
    if (cached) return { data: cached, source: "cache" };

    var staticData = null;
    try {
      staticData = await getJson(CONFIG.fallbackUrl);
      if (staticData && staticData.metadata && staticData.metadata.demo === false) {
        return { data: staticData, source: "static" };
      }
    } catch (e) { /* tiedostoa ei ole — jatketaan livehakuun */ }

    try {
      var data = await buildLive(say);
      await writeCache(data);
      return { data: data, source: "live" };
    } catch (err) {
      say("Livedatan haku epäonnistui — ladataan varasisältö…");
      if (staticData) return { data: staticData, source: "fallback", error: err.message };
      var fallback = await getJson(CONFIG.fallbackUrl);
      return { data: fallback, source: "fallback", error: err.message };
    }
  }

  /** Tyhjentää välimuistin (pakottaa tuoreen haun seuraavalla latauksella). */
  async function clearCache() {
    if ("caches" in window) {
      try { await caches.delete(CONFIG.cacheName); } catch (e) { /* ok */ }
    }
  }

  // buildLive on julkinen, jotta scripts/build-data.mjs voi käyttää samaa
  // logiikkaa esirakennetun tiedoston tuottamiseen (yksi totuuden lähde).
  return { load: load, clearCache: clearCache, buildLive: buildLive, CONFIG: CONFIG };
})();
