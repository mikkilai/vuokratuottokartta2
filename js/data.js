/* Vuokratuottokartta — aineiston haku ja rakennus selaimessa.
 *
 * Sivun auetessa haetaan suoraan Tilastokeskuksen avoimista rajapinnoista:
 *   1. Paavo-postinumeroalueet (rajat + väkiluku + mediaanitulot), geo.stat.fi WFS
 *   2. Vanhojen osakeasuntojen neliöhinnat postinumeroalueittain, StatFin/ashi
 *   3. Vapaarahoitteisten vuokra-asuntojen keskineliövuokrat, StatFin/asvu
 *
 * Valmis aineisto tallennetaan selaimen Cache API -välimuistiin (7 vrk),
 * jotta raskas haku tehdään vain kerran. Jos haku epäonnistuu (ei verkkoa,
 * rajapinta nurin), käytetään repossa olevaa data/areas.geojson-varatiedostoa.
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
    pxwebBase: "https://pxdata.stat.fi/PxWeb/api/v1/fi/StatFin",
    // Vanhojen osakeasuntojen hinnat postinumeroalueittain (vuositaulukko).
    priceDb: "ashi",
    priceTable: "statfin_ashi_pxt_13mu.px",
    priceMeasureRegex: /neli[öo]hinta|keskihinta|eur\/m2|€\/m2/i,
    // Vapaarahoitteisten vuokra-asuntojen vuokrat postinumeroalueittain.
    rentDb: "asvu",
    rentTable: "statfin_asvu_pxt_13beq.px",
    rentMeasureRegex: /neli[öo]vuokra|keskivuokra|eur\/m2|€\/m2/i,
    // Geometrian yksinkertaistus renderöinnin keventämiseksi (~60 m).
    simplifyTolerance: 0.0008,
    coordDecimals: 4,
    cacheName: "vtk-data-v1",
    cacheUrl: "/__vtk__/areas.json",
    cacheMaxAgeMs: 7 * 24 * 3600 * 1000,
    fallbackUrl: "data/areas.geojson",
  };

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

  /**
   * Hakee PxWeb-taulukosta uusimman vuoden arvot postinumeroittain.
   * Palauttaa { values: Map(postinumero -> €/m²), year, measureText }.
   */
  async function fetchPxTable(db, table, measureRegex, label) {
    var url = CONFIG.pxwebBase + "/" + db + "/" + table;
    var meta = await getJson(url);

    var dims = meta.variables;
    var postiDim = dims.find(function (d) { return /postinumero/i.test(d.text) || /^postinumero$/i.test(d.code); });
    var yearDim = dims.find(function (d) { return /vuosi/i.test(d.text) || /^vuosi$/i.test(d.code); });
    var infoDim = dims.find(function (d) { return /tiedot/i.test(d.text) || /^tiedot$/i.test(d.code); });
    if (!postiDim || !yearDim || !infoDim) {
      throw new Error("Taulukon " + table + " ulottuvuuksia ei tunnistettu (" + label + ")");
    }

    var latestYear = yearDim.values[yearDim.values.length - 1];
    var measureIdx = infoDim.valueTexts.findIndex(function (t) { return measureRegex.test(t); });
    if (measureIdx < 0) {
      throw new Error("Taulukosta " + table + " ei löytynyt tunnuslukua: " + label);
    }

    var stat = await getJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: [
          { code: postiDim.code, selection: { filter: "all", values: ["*"] } },
          { code: yearDim.code, selection: { filter: "item", values: [latestYear] } },
          { code: infoDim.code, selection: { filter: "item", values: [infoDim.values[measureIdx]] } },
        ],
        response: { format: "json-stat2" },
      }),
    });

    return {
      values: parseJsonStat2(stat, postiDim.code),
      year: latestYear,
      measureText: infoDim.valueTexts[measureIdx],
    };
  }

  /** Poimii json-stat2-vastauksesta Map: postinumerokoodi -> arvo. */
  function parseJsonStat2(stat, postiCode) {
    var dimId = stat.id.indexOf(postiCode) >= 0 ? postiCode :
      stat.id.find(function (id) { return /postinumero/i.test(id); });
    var dim = stat.dimension[dimId];
    var codes = Object.keys(dim.category.index).sort(function (a, b) {
      return dim.category.index[a] - dim.category.index[b];
    });

    var pos = stat.id.indexOf(dimId);
    var step = 1;
    for (var i = pos + 1; i < stat.id.length; i++) step *= stat.size[i];

    var out = new Map();
    codes.forEach(function (code, idx) {
      var v = stat.value[idx * step];
      if (v !== null && v !== undefined && isFinite(v)) {
        var m = String(code).match(/\d{5}/);
        if (m) out.set(m[0], v);
      }
    });
    return out;
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
    var results = await Promise.all([
      fetchPxTable(CONFIG.priceDb, CONFIG.priceTable, CONFIG.priceMeasureRegex, "neliöhinnat"),
      fetchPxTable(CONFIG.rentDb, CONFIG.rentTable, CONFIG.rentMeasureRegex, "keskivuokrat"),
    ]);
    var prices = results[0];
    var rents = results[1];

    say("Ladataan postinumeroalueiden rajoja…");
    var paavo = await getJsonWithProgress(CONFIG.wfsUrl, function (bytes) {
      say("Ladataan postinumeroalueiden rajoja… " + (bytes / 1e6).toFixed(1) + " Mt");
    });

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
          vuokra_m2: rents.values.has(code) ? rents.values.get(code) : null,
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
        sources: [
          "Tilastokeskus, Paavo-postinumeroalueet (CC BY 4.0)",
          "Tilastokeskus, StatFin " + CONFIG.priceTable + " (" + prices.measureText + ")",
          "Tilastokeskus, StatFin " + CONFIG.rentTable + " (" + rents.measureText + ")",
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
   * "cache" | "live" | "fallback".
   */
  async function load(onProgress) {
    var say = onProgress || function () {};

    var cached = await readCache();
    if (cached) return { data: cached, source: "cache" };

    try {
      var data = await buildLive(say);
      await writeCache(data);
      return { data: data, source: "live" };
    } catch (err) {
      say("Livedatan haku epäonnistui — ladataan varasisältö…");
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

  return { load: load, clearCache: clearCache, CONFIG: CONFIG };
})();
