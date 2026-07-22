/* Vuokratuottokartta — aineiston haku ja rakennus.
 *
 * Lähteet (Tilastokeskuksen avoin data, CC BY 4.0):
 *   1. Paavo-postinumeroalueet (rajat + väkiluku + mediaanitulot), geo.stat.fi WFS
 *   2. Vanhojen osakeasuntojen neliöhinnat ja kauppamäärät postinumeroalueittain
 *      (StatFin/ashi 13mu) sekä kunnittain (13mx) täydennykseen
 *   3. Keskineliövuokrat (StatFin/asvu) — ensisijaisesti postinumerotasolla
 *      (aktiivinen tai arkistokanta StatFin_Passiivi), muuten kuntatasolla
 *      (15fa, viimeiset neljä neljännestä yhdistettynä)
 *
 * PxWeb-rajapinnassa on pyyntömäärärajoitus (429), joten pyynnöt jonotetaan
 * pienellä välillä, metadata ja tietokantalistaukset välimuistitetaan, ja
 * useampi tunnusluku haetaan samasta taulukosta yhdellä kyselyllä.
 * Taulukot etsitään tietokantalistauksen kautta, jolloin poistuneita
 * tunnuksia ei turhaan kokeilla — tämä kestää StatFinin tunnusmuutokset.
 *
 * Valmis aineisto tallennetaan selaimen Cache API -välimuistiin (7 vrk).
 * Jos haku epäonnistuu, käytetään repossa olevaa data/areas.geojson-tiedostoa.
 */
var VTKData = (function () {
  "use strict";

  var CONFIG = {
    wfsBase: "https://geo.stat.fi/geoserver/postialue/wfs",
    // Ensisijainen taso sisältää tilastoattribuutit; pelkkä pno on varalla.
    wfsLayers: ["postialue:pno_tilasto", "postialue:pno"],
    // Attribuutit, jotka poimitaan jos taso ne tarjoaa. Postinumerokentän
    // nimi on vaihdellut, joten mukaan otetaan lisäksi kaikki skeeman
    // kentät, joiden nimessä on "posti" tai "pnro" (ks. fetchPaavo).
    wfsProps: ["posti_alue", "postinumeroalue", "pnro", "posti", "postinro",
      "nimi", "name", "namn", "kunta", "kuntanro", "he_vakiy", "hr_mtu"],
    // PxWeb-rajapinnan juuri; tietokantapolut sen alle.
    pxwebBase: "https://pxdata.stat.fi/PxWeb/api/v1/fi",
    priceDb: "StatFin/ashi",
    rentDb: "StatFin/asvu",
    rentDbArchive: "StatFin_Passiivi/asvu",

    // Vanhojen osakeasuntojen neliöhinnat ja kauppamäärät postinumeroalueittain.
    priceTables: ["statfin_ashi_pxt_13mu.px", "13mu.px", "13mu"],
    priceTableTextRegex: /neli[öo]hinnat.*postinumero/i,
    priceMeasureRegex: /neli[öo]hinta|keskihinta|eur\/m2|€\/m2/i,
    countMeasureRegex: /lukumäär|kauppo/i,
    // Neliöhinnat kunnittain (13mx) peitettyjen alueiden täydennykseen.
    kuntaPriceTables: ["statfin_ashi_pxt_13mx.px", "13mx.px", "13mx"],
    kuntaPriceTextRegex: /neli[öo]hinnat.*kunnittain/i,

    // Keskineliövuokrat postinumerotasolla (13eb; poistunut aktiivikannasta,
    // mahdollisesti arkistossa) ja aluetasolla (15fa).
    rentTables: ["statfin_asvu_pxt_13eb.px", "13eb.px", "13eb"],
    rentTableTextRegex: /keskineli[öo]vuokr|vuokr/i,
    rentArchiveTextRegex: /13eb|keskineli[öo]vuokr.*postinumero/i,
    rentAreaTables: ["statfin_asvu_pxt_15fa.px", "15fa.px", "15fa"],
    rentAreaTextRegex: /vuokraindeksi|keskineli[öo]vuokr/i,
    rentMeasureRegex: /neli[öo]vuokra|keskivuokra|eur\/m2|€\/m2/i,
    rentCountMeasureRegex: /lukumäär|havainto/i,

    // PxWeb-pyyntöjen jonotusväli ja 429-uudelleenyritykset.
    pxGapMs: 300,
    pxRetries: 2,

    // Geometrian yksinkertaistus renderöinnin keventämiseksi (~60 m).
    simplifyTolerance: 0.0008,
    coordDecimals: 4,
    cacheName: "vtk-data-v3",
    cacheUrl: "/__vtk__/areas.json",
    cacheMaxAgeMs: 7 * 24 * 3600 * 1000,
    fallbackUrl: "data/areas.geojson",
  };

  var POSTAL_DIM = /postinumero/i;
  var AREA_DIM = /alue|kunta/i;
  var TIME_DIM = /vuosi|neljännes|kuukausi/i;

  /* ------------------ PxWeb-pyyntöjen jonotus ------------------ */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  var pxChain = Promise.resolve();
  var pxLast = 0;

  /** Jonottaa PxWeb-pyynnöt (yksi kerrallaan, pieni väli) ja yrittää
   *  uudelleen 429-vastauksen tai verkkovirheen jälkeen. */
  function pxJson(url, options) {
    var run = function () { return pxAttempt(url, options, 0); };
    var p = pxChain.then(run, run);
    pxChain = p.catch(function () {});
    return p;
  }

  async function pxAttempt(url, options, tryNo) {
    var wait = pxLast + CONFIG.pxGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    pxLast = Date.now();
    var res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      // CORS-estetty 429 näkyy selaimessa verkkovirheenä — yksi uusinta
      // riittää; aidosti offline-tilanteessa ei kannata jäädä jonottamaan.
      if (tryNo < 1) {
        await sleep(2500);
        return pxAttempt(url, options, tryNo + 1);
      }
      throw new Error("Verkkovirhe (" + url.split("?")[0] + ")");
    }
    if (res.status === 429 && tryNo < CONFIG.pxRetries) {
      var ra = parseInt(res.headers.get("Retry-After"), 10);
      await sleep(isFinite(ra) && ra > 0 ? ra * 1000 : 4000 * (tryNo + 1));
      return pxAttempt(url, options, tryNo + 1);
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " (" + url.split("?")[0] + ")");
    return res.json();
  }

  // Metadata- ja listausvälimuistit, jotta samaa ei haeta kahdesti.
  var metaCache = {};
  var listingCache = {};

  function getMeta(url) {
    if (!metaCache[url]) {
      metaCache[url] = pxJson(url).catch(function (err) {
        delete metaCache[url];
        throw err;
      });
    }
    return metaCache[url];
  }

  /** Tietokannan taulukkolistaus; null jos listausta ei saada.
   *  Epäonnistumista ei jätetä välimuistiin, jotta seuraava kutsu voi
   *  yrittää uudelleen. */
  function getListing(db) {
    if (!(db in listingCache)) {
      listingCache[db] = pxJson(CONFIG.pxwebBase + "/" + db).catch(function () {
        delete listingCache[db];
        return null;
      });
    }
    return listingCache[db];
  }

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
   * Etsii toimivan taulukon. Jos tietokannan listaus on saatavilla,
   * kokeillaan vain siinä olevia tunnuksia (kandidaatit + kuvaustekstiin
   * täsmäävät) — poistuneita taulukoita ei siis turhaan kysellä. Löydetyn
   * taulukon metadatasta tarkistetaan vaadittu ulottuvuus.
   * Palauttaa { url, meta }.
   */
  async function resolveTable(db, candidates, tableTextRegex, requireDim, label) {
    var errors = [];
    var listing = await getListing(db);

    var ids = [];
    if (listing) {
      var baseOf = function (id) { return String(id).replace(/\.px$/i, "").toLowerCase(); };
      var listIds = listing.filter(function (it) { return it && it.id; });
      candidates.forEach(function (c) {
        var hit = listIds.find(function (it) { return baseOf(it.id) === baseOf(c); });
        if (hit && ids.indexOf(String(hit.id)) < 0) ids.push(String(hit.id));
      });
      listIds.forEach(function (it) {
        if (tableTextRegex.test(it.text || "") && ids.indexOf(String(it.id)) < 0) {
          ids.push(String(it.id));
        }
      });
      if (!ids.length) errors.push(db + ": ei sopivaa taulukkoa listauksessa");
    } else {
      ids = candidates.slice();
      errors.push(db + ": listaus ei saatavilla");
    }

    for (var i = 0; i < ids.length; i++) {
      var url = CONFIG.pxwebBase + "/" + db + "/" + ids[i];
      try {
        var meta = await getMeta(url);
        if (!meta || !meta.variables) throw new Error("ei metadataa");
        if (requireDim && !hasDim(meta, requireDim)) throw new Error("väärä rakenne");
        return { url: url, meta: meta };
      } catch (e) {
        errors.push(ids[i] + ": " + e.message);
      }
    }
    throw new Error("Taulukkoa ei löytynyt (" + label + "): " + errors.join("; "));
  }

  /**
   * Hakee taulukosta uusimman ajanjakson tunnusluvut alueittain yhdellä
   * kyselyllä. `measures` on { avain: regex } — ensimmäinen on pakollinen,
   * loput valinnaisia. Palauttaa { measures: {avain: Map|null}, year,
   * measureTexts, table, db, geoRegex, tableTextRegex }.
   */
  async function fetchPxTable(db, candidates, measures, tableTextRegex, geoRegex, label) {
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
    var quarterly = timeDim.values.some(function (v) { return /q/i.test(v); });
    var timeValues = quarterly ? timeDim.values.slice(-4)
      : [timeDim.values[timeDim.values.length - 1]];
    var periodLabel = timeValues.length > 1
      ? timeValues[0] + "–" + timeValues[timeValues.length - 1]
      : timeValues[0];

    // Etsi pyydetyt tunnusluvut; ensimmäinen avain on pakollinen. Jos useampi
    // teksti täsmää, suositaan uusinta sarjaa (esim. "vuodesta 2020 alkaen"
    // eikä "vuoteen 2019 asti").
    var keys = Object.keys(measures);
    var codesByKey = {};
    var textsByKey = {};
    keys.forEach(function (key) {
      var hits = [];
      infoDim.valueTexts.forEach(function (t, i) {
        if (measures[key].regex.test(t)) hits.push(i);
      });
      var idx = hits.find(function (i) { return !/asti/i.test(infoDim.valueTexts[i]); });
      if (idx === undefined) idx = hits[0];
      if (idx !== undefined) {
        codesByKey[key] = infoDim.values[idx];
        textsByKey[key] = infoDim.valueTexts[idx];
      }
    });
    if (!(keys[0] in codesByKey)) {
      throw new Error("Tunnuslukua ei löytynyt (" + label + "). Saatavilla: " + infoDim.valueTexts.join("; "));
    }
    var infoValues = keys.map(function (k) { return codesByKey[k]; })
      .filter(function (v, i, a) { return v !== undefined && a.indexOf(v) === i; });

    var query = [
      { code: geoDim.code, selection: { filter: "all", values: ["*"] } },
      { code: timeDim.code, selection: { filter: "item", values: timeValues } },
      { code: infoDim.code, selection: { filter: "item", values: infoValues } },
    ];
    // Muut ulottuvuudet (esim. Talotyyppi, Huoneluku): valitaan aito
    // kokonaissummaluokka, jos sellainen on. Osasumma kuten "Rivitalot
    // yhteensä" ei kelpaa: hyväksytään vain "Yhteensä"/"Kaikki"-alkuinen
    // teksti tai listan ensimmäinen yhteensä-luokka (esim. "Talotyypit
    // yhteensä"). Jos summaluokkaa ei ole, haetaan kaikki luokat ja
    // yhdistetään ne painotettuna (ks. extractMeasures).
    var findTotal = function (d) {
      var texts = d.valueTexts || [];
      for (var i = 0; i < texts.length; i++) {
        if (/^\s*(yhteensä|kaikki)\b/i.test(texts[i])) return i;
      }
      if (texts.length && /yhteensä|kaikki/i.test(texts[0])) return 0;
      return -1;
    };
    dims.forEach(function (d) {
      if (d === geoDim || d === timeDim || d === infoDim) return;
      var totalIdx = findTotal(d);
      query.push(totalIdx >= 0
        ? { code: d.code, selection: { filter: "item", values: [d.values[totalIdx]] } }
        : { code: d.code, selection: { filter: "all", values: ["*"] } });
    });

    // Diagnostiikka: taulukon rakenne ja tehty valinta (näkyy myös
    // Actions-lokissa, mikä helpottaa StatFin-muutosten selvittämistä).
    console.log("[VTK] " + label + ": " + url.split("/").pop() +
      " | dims: " + dims.map(function (d) {
        return d.code + "(" + (d.valueTexts || []).slice(0, 4).join("; ") +
          ((d.valueTexts || []).length > 4 ? "; …" : "") + ")";
      }).join(" · ") +
      " | valinta: " + JSON.stringify(query.map(function (q) {
        return q.code + "=" + q.selection.values.slice(0, 5).join(",");
      })));

    var stat = await pxJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, response: { format: "json-stat2" } }),
    });

    var out = extractMeasures(stat, geoDim.code, infoDim.code, codesByKey, measures);
    keys.forEach(function (key) {
      if (!(key in out)) out[key] = null;
    });

    return {
      measures: out,
      year: periodLabel,
      measureTexts: textsByKey,
      table: url.split("/").pop(),
      db: db,
      geoRegex: geoRegex,
      tableTextRegex: tableTextRegex,
    };
  }

  /**
   * Poimii json-stat2-vastauksesta tunnuslukujen arvot alueittain:
   * { avain: Map(aluekoodi -> arvo) }.
   *
   * Muiden ulottuvuuksien (neljännekset, talotyypit, huoneluvut) yli
   * yhdistetään näin: `sum: true` -tunnusluvut (lukumäärät) summataan, ja
   * muut keskiarvoistetaan `weightBy`-tunnusluvulla painottaen (esim.
   * neliöhinta painotetaan kauppamäärillä) — painojen puuttuessa
   * painottamatta. Arvot tallennetaan usealla avaimella (raakakoodi,
   * koodin numero-osa, pienaakkosin kirjoitettu nimi), jotta liitos
   * onnistuu koodimuodosta riippumatta.
   */
  function extractMeasures(stat, geoCode, infoCode, codesByKey, measures) {
    var geoId = stat.id.indexOf(geoCode) >= 0 ? geoCode :
      stat.id.find(function (id) { return POSTAL_DIM.test(id) || AREA_DIM.test(id); });
    var geoDim = stat.dimension[geoId];
    var labels = (geoDim.category && geoDim.category.label) || {};
    var codes = Object.keys(geoDim.category.index).sort(function (a, b) {
      return geoDim.category.index[a] - geoDim.category.index[b];
    });

    var n = stat.id.length;
    var sizes = stat.size;
    var strides = new Array(n);
    var stride = 1;
    for (var i = n - 1; i >= 0; i--) {
      strides[i] = stride;
      stride *= sizes[i];
    }
    var total = stride;
    var geoPos = stat.id.indexOf(geoId);
    var infoPos = stat.id.indexOf(infoCode);

    // Solmuindeksi ilman tunnuslukuulottuvuutta ("rest"): sen alla eri
    // tunnusluvut osuvat samaan soluun ja voidaan painottaa keskenään.
    var restStrides = new Array(n).fill(0);
    var restStride = 1;
    for (var j = n - 1; j >= 0; j--) {
      if (j === infoPos) continue;
      restStrides[j] = restStride;
      restStride *= sizes[j];
    }
    var restTotal = restStride;
    var geoRestStride = restStrides[geoPos];
    var geoSize = sizes[geoPos];

    // Tunnuslukuindeksi -> avain.
    var keyByInfoIdx = {};
    Object.keys(codesByKey).forEach(function (key) {
      if (infoPos < 0) return;
      var idxMap = stat.dimension[stat.id[infoPos]].category.index;
      if (idxMap && codesByKey[key] in idxMap) keyByInfoIdx[idxMap[codesByKey[key]]] = key;
    });

    // Kerää arvot per avain per rest-solu.
    var vals = {};
    Object.keys(codesByKey).forEach(function (key) {
      vals[key] = new Array(restTotal).fill(null);
    });
    for (var c = 0; c < total; c++) {
      var v = stat.value[c];
      if (v === null || v === undefined || !isFinite(v)) continue;
      var key;
      if (infoPos >= 0) {
        key = keyByInfoIdx[Math.floor(c / strides[infoPos]) % sizes[infoPos]];
        if (!key) continue;
      } else {
        key = Object.keys(codesByKey)[0];
      }
      var restIdx = 0;
      for (var d = 0; d < n; d++) {
        if (d === infoPos) continue;
        restIdx += (Math.floor(c / strides[d]) % sizes[d]) * restStrides[d];
      }
      vals[key][restIdx] = v;
    }

    // Yhdistä alueittain.
    var out = {};
    Object.keys(codesByKey).forEach(function (key) {
      var spec = measures[key] || {};
      var weightVals = spec.weightBy && vals[spec.weightBy] ? vals[spec.weightBy] : null;
      var perGeo = new Array(codes.length).fill(null);
      var acc = new Array(codes.length);
      for (var g = 0; g < codes.length; g++) acc[g] = { sum: 0, wsum: 0, plain: 0, count: 0 };
      for (var r = 0; r < restTotal; r++) {
        var v = vals[key][r];
        if (v === null) continue;
        var g2 = Math.floor(r / geoRestStride) % geoSize;
        var a = acc[g2];
        if (spec.sum) {
          a.sum += v;
          a.count++;
        } else {
          var w = weightVals ? weightVals[r] : null;
          if (w !== null && w > 0) {
            a.sum += v * w;
            a.wsum += w;
          }
          a.plain += v;
          a.count++;
        }
      }
      for (var g3 = 0; g3 < codes.length; g3++) {
        var a2 = acc[g3];
        if (a2.count === 0) continue;
        if (spec.sum) {
          perGeo[g3] = a2.sum;
        } else if (a2.wsum > 0) {
          perGeo[g3] = a2.sum / a2.wsum;
        } else {
          perGeo[g3] = a2.plain / a2.count;
        }
      }

      var map = new Map();
      codes.forEach(function (code, idx) {
        if (perGeo[idx] === null) return;
        var raw = String(code).trim();
        map.set(raw, perGeo[idx]);
        var digits = raw.match(/(\d{3,5})\s*$/);
        if (digits) map.set(digits[1], perGeo[idx]);
        if (labels[code]) map.set(String(labels[code]).trim().toLowerCase(), perGeo[idx]);
      });
      out[key] = map;
    });
    return out;
  }

  /**
   * Hakee keskivuokrat ja vuokrahavaintomäärät parhaalla saatavilla olevalla
   * tasolla: postinumerotaso (aktiivinen tai arkisto) tai kuntataso (15fa).
   * Palauttaa fetchPxTablen tuloksen + { level: "postinumero"|"kunta" }.
   */
  async function fetchRents() {
    var measures = {
      vuokra: { regex: CONFIG.rentMeasureRegex, weightBy: "havainnot" },
      havainnot: { regex: CONFIG.rentCountMeasureRegex, sum: true },
    };
    var errors = [];
    var postalSources = [
      { db: CONFIG.rentDb, candidates: CONFIG.rentTables, textRegex: CONFIG.rentTableTextRegex },
      { db: CONFIG.rentDbArchive, candidates: [], textRegex: CONFIG.rentArchiveTextRegex },
    ];
    for (var i = 0; i < postalSources.length; i++) {
      var src = postalSources[i];
      try {
        var t = await fetchPxTable(
          src.db, src.candidates, measures, src.textRegex, POSTAL_DIM, "keskivuokrat");
        t.level = "postinumero";
        return t;
      } catch (e) {
        errors.push(e.message);
      }
    }
    try {
      var t2 = await fetchPxTable(
        CONFIG.rentDb, CONFIG.rentAreaTables, measures,
        CONFIG.rentAreaTextRegex, AREA_DIM, "keskivuokrat, kuntataso");
      t2.level = "kunta";
      return t2;
    } catch (e) {
      errors.push(e.message);
      throw new Error("Vuokratietoja ei saatu: " + errors.join(" | "));
    }
  }

  /**
   * Hakee Paavo-postinumeroalueet WFS-rajapinnasta. Attribuuttilista
   * rakennetaan tason skeemasta (DescribeFeatureType), jotta pyyntö ei
   * kaadu kenttänimien muutoksiin; jos skeemaa ei saada tai rajattu pyyntö
   * epäonnistuu, haetaan taso ilman kenttärajausta.
   */
  async function fetchPaavo(say) {
    var errors = [];
    for (var i = 0; i < CONFIG.wfsLayers.length; i++) {
      var layer = CONFIG.wfsLayers[i];
      var common = CONFIG.wfsBase +
        "?service=WFS&version=2.0.0&request=GetFeature" +
        "&typeName=" + encodeURIComponent(layer) +
        "&outputFormat=application/json&srsName=EPSG:4326";

      var urls = [];
      try {
        var schema = await getJson(CONFIG.wfsBase +
          "?service=WFS&version=2.0.0&request=DescribeFeatureType" +
          "&typeName=" + encodeURIComponent(layer) +
          "&outputFormat=application/json");
        var ft = schema && schema.featureTypes && schema.featureTypes[0];
        var props = (ft && ft.properties) || [];
        var names = props.map(function (p) { return p.name; });
        var geomProp = props.find(function (p) { return /^gml:/i.test(p.type || ""); });
        var sel = CONFIG.wfsProps.filter(function (w) { return names.indexOf(w) >= 0; });
        names.forEach(function (n) {
          if (/posti|pnro/i.test(n) && sel.indexOf(n) < 0) sel.push(n);
        });
        if (geomProp) sel.push(geomProp.name);
        if (sel.length) {
          urls.push(common + "&propertyName=" + encodeURIComponent(sel.join(",")));
        }
      } catch (e) {
        errors.push(layer + " (skeema): " + e.message);
      }
      urls.push(common); // varalla ilman kenttärajausta (isompi lataus)

      for (var j = 0; j < urls.length; j++) {
        try {
          var data = await getJsonWithProgress(urls[j], function (bytes) {
            say("Ladataan postinumeroalueiden rajoja… " + (bytes / 1e6).toFixed(1) + " Mt");
          });
          if (data && data.features && data.features.length) return data;
          errors.push(layer + ": tyhjä vastaus");
        } catch (e) {
          errors.push(layer + ": " + e.message);
        }
      }
    }
    throw new Error("Paavo-aineistoa ei saatu: " + errors.join("; "));
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

    // Haut tehdään peräkkäin jonon kautta, jotta PxWeb:n pyyntömääräraja
    // ei ylity. Hinta + kauppamäärä ja vuokra + havainnot haetaan
    // yhdistettyinä kyselyinä.
    say("Haetaan hintatilastoja (Tilastokeskus)…");
    var prices = await fetchPxTable(
      CONFIG.priceDb, CONFIG.priceTables,
      { hinta: { regex: CONFIG.priceMeasureRegex, weightBy: "kaupat" },
        kaupat: { regex: CONFIG.countMeasureRegex, sum: true } },
      CONFIG.priceTableTextRegex, POSTAL_DIM, "neliöhinnat");

    say("Haetaan vuokratilastoja…");
    var rents = await fetchRents();

    say("Haetaan kuntatason täydennystietoja…");
    var kuntaPrices = await fetchPxTable(
      CONFIG.priceDb, CONFIG.kuntaPriceTables,
      { hinta: { regex: CONFIG.priceMeasureRegex, weightBy: "kaupat" },
        kaupat: { regex: CONFIG.countMeasureRegex, sum: true } },
      CONFIG.kuntaPriceTextRegex, AREA_DIM, "neliöhinnat, kuntataso")
      .catch(function () { return null; });
    var kuntaRents = rents.level === "kunta" ? rents :
      await fetchPxTable(CONFIG.rentDb, CONFIG.rentAreaTables,
        { vuokra: { regex: CONFIG.rentMeasureRegex } }, CONFIG.rentAreaTextRegex,
        AREA_DIM, "keskivuokrat, kuntataso")
        .catch(function () { return null; });

    say("Ladataan postinumeroalueiden rajoja…");
    var paavo = await fetchPaavo(say);

    var lookup = function (map, key) {
      return map && map.has(key) ? map.get(key) : null;
    };
    var kuntaKey = function (kuntaCode) {
      var k = String(kuntaCode || "").replace(/\D/g, "");
      while (k.length > 0 && k.length < 3) k = "0" + k;
      return k;
    };
    var roundOrNull = function (v) { return v === null ? null : Math.round(v); };

    // Postinumerokentän nimi on vaihdellut Paavo-aineistossa — tunnista se
    // datasta: ensin tutuilla nimillä, sitten kenttä, jonka arvo on viiden
    // numeron merkkijono. Viimeinen varakeino on featuren id (esim.
    // "pno_tilasto.00100").
    var postalKey = (function () {
      var f0 = paavo.features.find(function (f) { return f && f.properties; });
      if (!f0) return null;
      var keys = Object.keys(f0.properties);
      var isCode = function (v) { return typeof v === "string" && /^\d{5}$/.test(v.trim()); };
      var named = keys.find(function (k) {
        return /posti|pnro/i.test(k) && isCode(f0.properties[k]);
      });
      if (named) return named;
      return keys.find(function (k) { return isCode(f0.properties[k]); }) || null;
    })();
    var postalOf = function (f) {
      var v = postalKey ? String(f.properties[postalKey] || "").trim() : "";
      if (/^\d{1,5}$/.test(v)) {
        while (v.length < 5) v = "0" + v;
        return v;
      }
      var m = String(f.id || "").match(/(\d{5})(?!.*\d)/);
      return m ? m[1] : "";
    };

    say("Rakennetaan karttaa…");
    var features = paavo.features.map(function (f) {
      var p = f.properties;
      var code = postalOf(f);
      var kk = kuntaKey(p.kunta);
      var postal = rents.level === "postinumero";
      return {
        type: "Feature",
        properties: {
          posti_alue: code,
          nimi: p.nimi || p.name || p.namn || "",
          kunta: p.kunta || p.kuntanro || "",
          hinta_m2: lookup(prices.measures.hinta, code),
          vuokra_m2: postal ? lookup(rents.measures.vuokra, code) : null,
          kaupat: roundOrNull(lookup(prices.measures.kaupat, code)),
          havainnot: roundOrNull(postal
            ? lookup(rents.measures.havainnot, code)
            : lookup(rents.measures.havainnot, kk)),
          kunta_hinta_m2: kuntaPrices ? lookup(kuntaPrices.measures.hinta, kk) : null,
          kunta_vuokra_m2: kuntaRents ? lookup(kuntaRents.measures.vuokra, kk) : null,
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
          "Tilastokeskus, StatFin " + prices.table + " (" + prices.measureTexts.hinta + ")",
          "Tilastokeskus, StatFin " + rents.table + " (" + rents.measureTexts.vuokra +
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
