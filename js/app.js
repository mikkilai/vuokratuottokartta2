/* Vuokratuottokartta — postinumeroalueiden vuokratuotto kartalla.
 * Vanilla JS + Leaflet. Data: VTKData (js/data.js). */
(function () {
  "use strict";

  var DEFAULTS = {
    vastike: 4.5,
    vajaakaytto: 5,
    vero: 1.5,
    paaomavero: false,
    paaomaveroPct: 30,
    minBrutto: 0,
    minKaupat: 0,
    fillKunta: true,
  };
  var STORAGE_KEY = "vtk-asetukset";

  // Väriasteikko tuotolle (%). Alarajat nousevassa järjestyksessä.
  var BINS = [
    { min: 10, color: "#084c24", label: "yli 10 %" },
    { min: 8, color: "#0b5c2e", label: "8–10 %" },
    { min: 7, color: "#1f7a3f", label: "7–8 %" },
    { min: 6, color: "#4d9a55", label: "6–7 %" },
    { min: 5, color: "#8dbb6c", label: "5–6 %" },
    { min: 4, color: "#cfd489", label: "4–5 %" },
    { min: 3, color: "#e8b95e", label: "3–4 %" },
    { min: -Infinity, color: "#d97b4f", label: "alle 3 %" },
  ];
  var NO_DATA_COLOR = "#b6bec6";
  var SCALE_MIN = 2; // gradienttipalkin asteikko popupissa
  var SCALE_MAX = 11;

  var state = {
    metric: "brutto",
    settings: loadSettings(),
    selectedId: null,
  };

  var map, geoLayer;

  /* ---------- Laskenta ---------- */

  /** Palauttaa alueen laskennassa käytettävät arvot ja tiedon siitä,
   *  onko peitetty tieto täydennetty kuntatason keskiarvolla. */
  function effective(p) {
    var s = state.settings;
    var hinta = isFinite(p.hinta_m2) && p.hinta_m2 !== null ? p.hinta_m2 : null;
    var vuokra = isFinite(p.vuokra_m2) && p.vuokra_m2 !== null ? p.vuokra_m2 : null;
    var hintaKunta = false;
    var vuokraKunta = false;
    if (s.fillKunta) {
      if (hinta === null && isFinite(p.kunta_hinta_m2) && p.kunta_hinta_m2 !== null) {
        hinta = p.kunta_hinta_m2;
        hintaKunta = true;
      }
      if (vuokra === null && isFinite(p.kunta_vuokra_m2) && p.kunta_vuokra_m2 !== null) {
        vuokra = p.kunta_vuokra_m2;
        vuokraKunta = true;
      }
    }
    return { hinta: hinta, vuokra: vuokra, hintaKunta: hintaKunta, vuokraKunta: vuokraKunta };
  }

  function bruttoTuotto(eff) {
    if (eff.hinta === null || eff.vuokra === null || eff.hinta <= 0) return null;
    return (eff.vuokra * 12) / eff.hinta * 100;
  }

  function nettoTuotto(eff) {
    if (eff.hinta === null || eff.vuokra === null || eff.hinta <= 0) return null;
    var s = state.settings;
    var vuosituotto = (eff.vuokra * (1 - s.vajaakaytto / 100) - s.vastike) * 12;
    var hankintahinta = eff.hinta * (1 + s.vero / 100);
    var netto = vuosituotto / hankintahinta * 100;
    if (s.paaomavero && netto > 0) netto *= 1 - s.paaomaveroPct / 100;
    return netto;
  }

  /** Suodattimet: palauttaa true, jos alue rajataan harmaaksi. */
  function isFiltered(p, eff) {
    var s = state.settings;
    var brutto = bruttoTuotto(eff);
    if (brutto !== null && brutto < s.minBrutto) return true;
    // Kauppasuodatin koskee vain alueita, joilla on postinumerotason hintatieto.
    if (s.minKaupat > 0 && p.hinta_m2 !== null) {
      var kaupat = isFinite(p.kaupat) && p.kaupat !== null ? p.kaupat : 0;
      if (kaupat < s.minKaupat) return true;
    }
    return false;
  }

  function metricValue(p) {
    var eff = effective(p);
    if (isFiltered(p, eff)) return null;
    return state.metric === "brutto" ? bruttoTuotto(eff) : nettoTuotto(eff);
  }

  function colorFor(value) {
    if (value === null) return NO_DATA_COLOR;
    for (var i = 0; i < BINS.length; i++) {
      if (value >= BINS[i].min) return BINS[i].color;
    }
    return NO_DATA_COLOR;
  }

  /* ---------- Muotoilut ---------- */

  function fmtPct(v) {
    if (v === null) return "–";
    return v.toLocaleString("fi-FI", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " %";
  }

  function fmtEur(v, unit) {
    if (v === null || v === undefined || !isFinite(v)) return "–";
    return v.toLocaleString("fi-FI", { maximumFractionDigits: v < 100 ? 2 : 0 }) + (unit ? " " + unit : "");
  }

  function fmtInt(v) {
    if (v === null || v === undefined || !isFinite(v)) return "–";
    return Math.round(v).toLocaleString("fi-FI");
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Asetukset ---------- */

  function loadSettings() {
    var out = Object.assign({}, DEFAULTS);
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && typeof saved === "object") {
        Object.keys(DEFAULTS).forEach(function (k) {
          if (typeof DEFAULTS[k] === "boolean") {
            if (typeof saved[k] === "boolean") out[k] = saved[k];
          } else if (isFinite(saved[k])) {
            out[k] = saved[k];
          }
        });
      }
    } catch (e) { /* ei tallennettuja asetuksia */ }
    return out;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch (e) { /* yksityinen selaus tms. */ }
  }

  /* ---------- Kartta ---------- */

  function style(feature) {
    var v = metricValue(feature.properties);
    var selected = feature.properties.posti_alue === state.selectedId;
    return {
      fillColor: colorFor(v),
      fillOpacity: v === null ? 0.35 : 0.72,
      color: selected ? "#14202b" : "#ffffff",
      weight: selected ? 2.5 : 1,
    };
  }

  function onEachFeature(feature, layer) {
    layer.on("click", function () {
      selectArea(feature.properties.posti_alue, layer, false);
    });
    layer.on("mouseover", function () {
      if (feature.properties.posti_alue !== state.selectedId) {
        layer.setStyle({ weight: 2, color: "#14202b" });
      }
    });
    layer.on("mouseout", function () {
      geoLayer.resetStyle(layer);
    });
    layer.bindTooltip(
      feature.properties.posti_alue + " " + (feature.properties.nimi || ""),
      { sticky: true, direction: "top" }
    );
  }

  function selectArea(id, layer, zoom) {
    state.selectedId = id;
    geoLayer.setStyle(style);
    if (zoom) {
      try { map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 12 }); } catch (e) { /* ok */ }
    }
    layer.unbindPopup();
    layer.bindPopup(popupHtml(layer.feature.properties), { maxWidth: 300 }).openPopup();
  }

  /* ---------- Popup ---------- */

  function popupHtml(p) {
    var eff = effective(p);
    var brutto = bruttoTuotto(eff);
    var netto = nettoTuotto(eff);

    var kuntaMark = '<span class="kuntataso" title="Täydennetty kuntatason keskiarvolla"> (kuntataso)</span>';
    var rows = "";
    var row = function (label, value) {
      rows += "<tr><th>" + label + "</th><td>" + value + "</td></tr>";
    };
    row("Neliöhinta", fmtEur(eff.hinta, "€/m²") + (eff.hintaKunta ? kuntaMark : ""));
    row("Keskineliövuokra", fmtEur(eff.vuokra, "€/m²/kk") + (eff.vuokraKunta ? kuntaMark : ""));
    row("Kauppoja", fmtInt(p.kaupat));
    row("Vuokrahavaintoja", fmtInt(p.havainnot));
    row("Väkiluku", fmtInt(p.vakiluku));
    row("Mediaanitulot", p.mediaanitulo ? fmtInt(p.mediaanitulo) + " €/v" : "–");

    var scale = "";
    if (brutto !== null) {
      var pct = Math.max(0, Math.min(1, (brutto - SCALE_MIN) / (SCALE_MAX - SCALE_MIN))) * 100;
      scale =
        '<div class="scale-bar"><div class="scale-marker" style="left:' + pct.toFixed(1) + '%"></div></div>' +
        '<div class="scale-caption"><span>' + SCALE_MIN + ' %</span><span>bruttotuotto</span><span>' + SCALE_MAX + ' %</span></div>';
    }

    return (
      '<div class="area-popup">' +
      "<h3>" + (p.posti_alue ? esc(p.posti_alue) + " " : "") + esc(p.nimi || "") + "</h3>" +
      '<p class="popup-sub">' + esc(p.kunta ? "Kunta " + p.kunta : "") + "</p>" +
      '<div class="popup-yields">' +
      '<div class="popup-yield"><span>Bruttotuotto</span><b>' + fmtPct(brutto) + "</b></div>" +
      '<div class="popup-yield"><span>Nettotuotto</span><b>' + fmtPct(netto) + "</b></div>" +
      "</div>" +
      "<table>" + rows + "</table>" +
      scale +
      "</div>"
    );
  }

  /* ---------- Selite ---------- */

  function renderLegend() {
    var el = document.getElementById("legend");
    var title = state.metric === "brutto" ? "Bruttotuotto" : "Nettotuotto";
    var html = '<div class="legend-title">' + title + "</div>";
    BINS.forEach(function (b) {
      html += '<div class="legend-row"><span class="swatch" style="background:' +
        b.color + '"></span>' + b.label + "</div>";
    });
    html += '<div class="legend-row"><span class="swatch" style="background:' +
      NO_DATA_COLOR + '"></span>ei tilastoa / suodatettu</div>';
    el.innerHTML = html;
  }

  function refresh() {
    if (geoLayer) {
      geoLayer.setStyle(style);
      geoLayer.eachLayer(function (layer) {
        if (layer.getPopup() && layer.isPopupOpen()) {
          layer.setPopupContent(popupHtml(layer.feature.properties));
        }
      });
    }
    renderLegend();
  }

  /* ---------- Haku ---------- */

  function findArea(query) {
    if (!geoLayer) return null;
    var q = query.trim().toLowerCase();
    if (!q) return null;
    var exact = null, prefix = null, name = null;
    geoLayer.eachLayer(function (layer) {
      var p = layer.feature.properties;
      var code = String(p.posti_alue);
      var nimi = String(p.nimi || "").toLowerCase();
      if (!exact && code === q) exact = layer;
      if (!prefix && /^\d{2,5}$/.test(q) && code.indexOf(q) === 0) prefix = layer;
      if (!name && nimi.indexOf(q) >= 0) name = layer;
    });
    return exact || prefix || name;
  }

  function doSearch() {
    var input = document.getElementById("in-haku");
    var status = document.getElementById("haku-status");
    var layer = findArea(input.value);
    if (layer) {
      status.hidden = true;
      selectArea(layer.feature.properties.posti_alue, layer, true);
    } else {
      status.textContent = "Ei osumia haulle “" + input.value.trim() + "”.";
      status.hidden = false;
    }
  }

  /* ---------- Asetusten UI ---------- */

  var SLIDERS = [
    // [input, output, avain, desimaalit, yksikkö]
    ["in-minbrutto", "out-minbrutto", "minBrutto", 1, " %"],
    ["in-minkaupat", "out-minkaupat", "minKaupat", 0, ""],
    ["in-vastike", "out-vastike", "vastike", 1, " €/m²/kk"],
    ["in-vajaakaytto", "out-vajaakaytto", "vajaakaytto", 0, " %"],
    ["in-vero", "out-vero", "vero", 1, " %"],
  ];

  function renderSliderValue(row) {
    var value = state.settings[row[2]];
    document.getElementById(row[1]).textContent =
      value.toLocaleString("fi-FI", {
        minimumFractionDigits: row[3], maximumFractionDigits: row[3],
      }) + row[4];
    document.getElementById(row[0]).value = value;
  }

  function initSettings() {
    SLIDERS.forEach(function (row) {
      renderSliderValue(row);
      document.getElementById(row[0]).addEventListener("input", function () {
        state.settings[row[2]] = parseFloat(this.value);
        renderSliderValue(row);
        saveSettings();
        refresh();
      });
    });

    var fill = document.getElementById("in-taydenna");
    fill.checked = state.settings.fillKunta;
    fill.addEventListener("change", function () {
      state.settings.fillKunta = fill.checked;
      saveSettings();
      refresh();
    });

    var pvero = document.getElementById("in-paaomavero");
    var pveroPct = document.getElementById("in-paaomavero-pct");
    pvero.checked = state.settings.paaomavero;
    pveroPct.value = String(state.settings.paaomaveroPct);
    pvero.addEventListener("change", function () {
      state.settings.paaomavero = pvero.checked;
      saveSettings();
      refresh();
    });
    pveroPct.addEventListener("change", function () {
      state.settings.paaomaveroPct = parseFloat(pveroPct.value);
      saveSettings();
      refresh();
    });
  }

  /* ---------- Yleis-UI ---------- */

  function setMetric(metric) {
    state.metric = metric;
    ["btn-brutto", "btn-brutto-panel"].forEach(function (id) {
      document.getElementById(id).classList.toggle("active", metric === "brutto");
    });
    ["btn-netto", "btn-netto-panel"].forEach(function (id) {
      document.getElementById(id).classList.toggle("active", metric === "netto");
    });
    refresh();
  }

  function initUi() {
    ["btn-brutto", "btn-brutto-panel"].forEach(function (id) {
      document.getElementById(id).addEventListener("click", function () { setMetric("brutto"); });
    });
    ["btn-netto", "btn-netto-panel"].forEach(function (id) {
      document.getElementById(id).addEventListener("click", function () { setMetric("netto"); });
    });

    document.getElementById("btn-oletukset").addEventListener("click", function () {
      var panel = document.getElementById("settings-panel");
      panel.hidden = !panel.hidden;
      if (!panel.hidden) document.getElementById("in-haku").focus();
    });
    document.getElementById("btn-tietoa").addEventListener("click", function () {
      document.getElementById("info-modal").hidden = false;
    });
    document.getElementById("link-tietoa").addEventListener("click", function (e) {
      e.preventDefault();
      document.getElementById("info-modal").hidden = false;
    });

    document.getElementById("btn-haku").addEventListener("click", doSearch);
    document.getElementById("in-haku").addEventListener("keydown", function (e) {
      if (e.key === "Enter") doSearch();
    });

    document.querySelectorAll("[data-close]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById(btn.getAttribute("data-close")).hidden = true;
      });
    });
    document.getElementById("info-modal").addEventListener("click", function (e) {
      if (e.target === this) this.hidden = true;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        document.getElementById("info-modal").hidden = true;
        document.getElementById("settings-panel").hidden = true;
      }
    });
    document.getElementById("demo-banner-close").addEventListener("click", function () {
      document.getElementById("demo-banner").hidden = true;
    });
  }

  function showDataBanner(result) {
    var banner = document.getElementById("demo-banner");
    var text = document.getElementById("demo-banner-text");
    var isDemo = result.data.metadata && result.data.metadata.demo;
    if (result.source === "fallback" || isDemo) {
      text.textContent =
        "Tilastokeskuksen rajapintaan ei juuri nyt saatu yhteyttä, joten kartalla " +
        "näytetään suuntaa-antava esimerkkiaineisto. Lataa sivu myöhemmin uudelleen." +
        (result.error ? " (" + result.error + ")" : "");
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  /* ---------- Käynnistys ---------- */

  function init() {
    map = L.map("map", { zoomSnap: 0.5 }).setView([64.5, 26.0], 5.5);
    // Harmaasävyinen taustakartta (CartoDB Positron), jotta tuottovärit erottuvat.
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
        ' &copy; <a href="https://carto.com/attributions">CARTO</a>' +
        ' | Tilastot: <a href="https://stat.fi/">Tilastokeskus</a> (CC BY 4.0)',
    }).addTo(map);

    initUi();
    initSettings();
    renderLegend();

    var loading = document.getElementById("loading");
    loading.hidden = false;
    loading.textContent = "Ladataan aineistoa…";
    VTKData.load(function (msg) { loading.textContent = msg; })
      .then(function (result) {
        loading.hidden = true;
        showDataBanner(result);
        geoLayer = L.geoJSON(result.data, { style: style, onEachFeature: onEachFeature }).addTo(map);
        try {
          map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] });
        } catch (e) { /* tyhjä aineisto */ }
      })
      .catch(function (err) {
        loading.textContent = "Aineiston lataus epäonnistui: " + err.message;
      });
  }

  init();
})();
