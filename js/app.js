/* Vuokratuottokartta — postinumeroalueiden vuokratuotto kartalla.
 * Vanilla JS + Leaflet. Data: data/areas.geojson (ks. scripts/build-data.mjs). */
(function () {
  "use strict";

  var DEFAULTS = { vastike: 4.5, vajaakaytto: 5, vero: 1.5 };
  var STORAGE_KEY = "vtk-oletukset";

  // Väriasteikko tuotolle (%). Alarajat nousevassa järjestyksessä.
  var BINS = [
    { min: 8, color: "#0b5c2e", label: "yli 8 %" },
    { min: 7, color: "#1f7a3f", label: "7–8 %" },
    { min: 6, color: "#4d9a55", label: "6–7 %" },
    { min: 5, color: "#8dbb6c", label: "5–6 %" },
    { min: 4, color: "#cfd489", label: "4–5 %" },
    { min: 3, color: "#e8b95e", label: "3–4 %" },
    { min: -Infinity, color: "#d97b4f", label: "alle 3 %" },
  ];
  var NO_DATA_COLOR = "#b6bec6";

  var state = {
    metric: "brutto",
    assumptions: loadAssumptions(),
    selectedId: null,
  };

  var map, geoLayer;

  /* ---------- Laskenta ---------- */

  function bruttoTuotto(p) {
    if (!isFinite(p.hinta_m2) || !isFinite(p.vuokra_m2) || p.hinta_m2 <= 0) return null;
    return (p.vuokra_m2 * 12) / p.hinta_m2 * 100;
  }

  function nettoTuotto(p) {
    if (!isFinite(p.hinta_m2) || !isFinite(p.vuokra_m2) || p.hinta_m2 <= 0) return null;
    var a = state.assumptions;
    var vuosituotto = (p.vuokra_m2 * (1 - a.vajaakaytto / 100) - a.vastike) * 12;
    var hankintahinta = p.hinta_m2 * (1 + a.vero / 100);
    return vuosituotto / hankintahinta * 100;
  }

  function metricValue(p) {
    return state.metric === "brutto" ? bruttoTuotto(p) : nettoTuotto(p);
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
    return v.toLocaleString("fi-FI", { maximumFractionDigits: v < 100 ? 2 : 0 }) + " " + unit;
  }

  function fmtInt(v) {
    if (v === null || v === undefined || !isFinite(v)) return "–";
    return v.toLocaleString("fi-FI");
  }

  /* ---------- Oletukset ---------- */

  function loadAssumptions() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && typeof saved === "object") {
        return {
          vastike: isFinite(saved.vastike) ? saved.vastike : DEFAULTS.vastike,
          vajaakaytto: isFinite(saved.vajaakaytto) ? saved.vajaakaytto : DEFAULTS.vajaakaytto,
          vero: isFinite(saved.vero) ? saved.vero : DEFAULTS.vero,
        };
      }
    } catch (e) { /* ei tallennettuja asetuksia */ }
    return Object.assign({}, DEFAULTS);
  }

  function saveAssumptions() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.assumptions));
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
      state.selectedId = feature.properties.posti_alue;
      geoLayer.setStyle(style);
      showAreaPanel(feature.properties);
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

  function renderLegend() {
    var el = document.getElementById("legend");
    var title = state.metric === "brutto" ? "Bruttotuotto" : "Nettotuotto";
    var html = '<div class="legend-title">' + title + "</div>";
    BINS.forEach(function (b) {
      html += '<div class="legend-row"><span class="swatch" style="background:' +
        b.color + '"></span>' + b.label + "</div>";
    });
    html += '<div class="legend-row"><span class="swatch" style="background:' +
      NO_DATA_COLOR + '"></span>ei tilastoa</div>';
    el.innerHTML = html;
  }

  function refresh() {
    if (geoLayer) geoLayer.setStyle(style);
    renderLegend();
    if (state.selectedId && geoLayer) {
      geoLayer.eachLayer(function (layer) {
        if (layer.feature.properties.posti_alue === state.selectedId) {
          updateAreaPanel(layer.feature.properties);
        }
      });
    }
  }

  /* ---------- Aluepaneeli ---------- */

  function showAreaPanel(p) {
    updateAreaPanel(p);
    document.getElementById("settings-panel").hidden = true;
    document.getElementById("area-panel").hidden = false;
  }

  function updateAreaPanel(p) {
    var a = state.assumptions;
    setText("ap-title", p.posti_alue + " " + (p.nimi || ""));
    setText("ap-subtitle", p.kunta || "");
    setText("ap-brutto", fmtPct(bruttoTuotto(p)));
    setText("ap-netto", fmtPct(nettoTuotto(p)));
    setText("ap-hinta", fmtEur(p.hinta_m2, "€/m²"));
    setText("ap-vuokra", fmtEur(p.vuokra_m2, "€/m²/kk"));
    setText("ap-vakiluku", fmtInt(p.vakiluku));
    setText("ap-tulo", p.mediaanitulo ? fmtInt(p.mediaanitulo) + " €/v" : "–");

    var calcEl = document.getElementById("ap-laskelma");
    if (isFinite(p.hinta_m2) && isFinite(p.vuokra_m2)) {
      calcEl.innerHTML =
        "<p>Brutto: (" + fmtEur(p.vuokra_m2, "€") + " × 12) ÷ " +
        fmtEur(p.hinta_m2, "€") + " = <strong>" + fmtPct(bruttoTuotto(p)) + "</strong></p>" +
        "<p>Netto: ((" + fmtEur(p.vuokra_m2, "€") + " × " +
        (1 - a.vajaakaytto / 100).toLocaleString("fi-FI", { maximumFractionDigits: 3 }) +
        " − " + fmtEur(a.vastike, "€") + ") × 12) ÷ (" + fmtEur(p.hinta_m2, "€") + " × " +
        (1 + a.vero / 100).toLocaleString("fi-FI", { maximumFractionDigits: 3 }) +
        ") = <strong>" + fmtPct(nettoTuotto(p)) + "</strong></p>" +
        "<p>Oletukset: hoitovastike " + fmtEur(a.vastike, "€/m²/kk") +
        ", vajaakäyttö " + fmtPct(a.vajaakaytto).replace(" %", " %") +
        ", varainsiirtovero " + fmtPct(a.vero).replace(" %", " %") + ".</p>";
    } else {
      calcEl.innerHTML = "<p>Alueelta ei julkaista hinta- tai vuokratilastoa vähäisten havaintojen vuoksi.</p>";
    }
  }

  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  /* ---------- Oletukset-UI ---------- */

  function bindSetting(inputId, outputId, key, decimals) {
    var input = document.getElementById(inputId);
    var output = document.getElementById(outputId);
    input.value = state.assumptions[key];
    output.textContent = state.assumptions[key].toLocaleString("fi-FI", {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
    input.addEventListener("input", function () {
      state.assumptions[key] = parseFloat(input.value);
      output.textContent = state.assumptions[key].toLocaleString("fi-FI", {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      });
      saveAssumptions();
      refresh();
    });
  }

  function initSettings() {
    bindSetting("in-vastike", "out-vastike", "vastike", 2);
    bindSetting("in-vajaakaytto", "out-vajaakaytto", "vajaakaytto", 1);
    bindSetting("in-vero", "out-vero", "vero", 1);
    document.getElementById("btn-reset").addEventListener("click", function () {
      state.assumptions = Object.assign({}, DEFAULTS);
      saveAssumptions();
      initSettingValues();
      refresh();
    });
  }

  function initSettingValues() {
    [["in-vastike", "out-vastike", "vastike", 2],
     ["in-vajaakaytto", "out-vajaakaytto", "vajaakaytto", 1],
     ["in-vero", "out-vero", "vero", 1]].forEach(function (row) {
      var input = document.getElementById(row[0]);
      var output = document.getElementById(row[1]);
      input.value = state.assumptions[row[2]];
      output.textContent = state.assumptions[row[2]].toLocaleString("fi-FI", {
        minimumFractionDigits: row[3], maximumFractionDigits: row[3],
      });
    });
  }

  /* ---------- Yleis-UI ---------- */

  function initUi() {
    document.getElementById("btn-brutto").addEventListener("click", function () {
      setMetric("brutto");
    });
    document.getElementById("btn-netto").addEventListener("click", function () {
      setMetric("netto");
    });
    document.getElementById("btn-oletukset").addEventListener("click", function () {
      var panel = document.getElementById("settings-panel");
      var wasHidden = panel.hidden;
      panel.hidden = !wasHidden;
      if (!panel.hidden) document.getElementById("area-panel").hidden = true;
    });
    document.getElementById("btn-tietoa").addEventListener("click", function () {
      document.getElementById("info-modal").hidden = false;
    });
    document.querySelectorAll("[data-close]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById(btn.getAttribute("data-close")).hidden = true;
        if (btn.getAttribute("data-close") === "area-panel") {
          state.selectedId = null;
          if (geoLayer) geoLayer.setStyle(style);
        }
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

  function setMetric(metric) {
    state.metric = metric;
    document.getElementById("btn-brutto").classList.toggle("active", metric === "brutto");
    document.getElementById("btn-netto").classList.toggle("active", metric === "netto");
    refresh();
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
        var geojson = result.data;
        showDataBanner(result);
        geoLayer = L.geoJSON(geojson, { style: style, onEachFeature: onEachFeature }).addTo(map);
        try {
          map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] });
        } catch (e) { /* tyhjä aineisto */ }
      })
      .catch(function (err) {
        loading.textContent = "Aineiston lataus epäonnistui: " + err.message;
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

  init();
})();
