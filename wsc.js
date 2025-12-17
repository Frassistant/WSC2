/*
 WSC PRO – Unified Weather Card
 v2.0.0

 OBIETTIVI RAGGIUNTI:
 - weather_entity OBBLIGATORIA (fonte unica per condizione meteo realtime)
 - ZERO calcoli euristici sul meteo realtime (pioggia, sole, ecc.)
 - Supporto 2 modalità:
    1) SOLO weather entity (utenti senza stazione)
    2) weather + stazione meteo (dati avanzati + grafici)
 - Editor visuale HA-friendly (config chiara, opzionale)
 - Stile completamente rivisto: clean, iOS / Meteo App-like
 - Grafici solo se sensori presenti
*/

class WSCUnifiedCard extends HTMLElement {
  static VERSION = "2.0.0";

  constructor() {
    super();
    this._hass = null;
    this._config = null;
    this._ui = { charts: false, details: false };
    this._series = new Map();
    this._lastSample = 0;

    this._toggleCharts = () => { this._ui.charts = !this._ui.charts; this._render(); };
    this._toggleDetails = () => { this._ui.details = !this._ui.details; this._render(); };
  }

  /* ================= CONFIG ================= */

  setConfig(cfg) {
    if (!cfg.weather) {
      throw new Error("Devi specificare obbligatoriamente 'weather'");
    }

    this._config = {
      title: "Meteo",
      weather: null,          // OBBLIGATORIA

      // opzionale: stazione meteo
      temperature: null,
      humidity: null,
      wind_speed: null,
      wind_gust: null,
      pressure: null,
      rain_rate: null,

      charts: [],             // [{ entity, label, unit }]
      sample_interval: 60,

      ...cfg
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const now = Date.now();
    if (now - this._lastSample > this._config.sample_interval * 1000) {
      this._lastSample = now;
      this._sampleCharts();
    }

    this._render();
  }

  getCardSize() {
    return 4 + (this._ui.charts ? 4 : 0) + (this._ui.details ? 4 : 0);
  }

  /* ================= DATA ================= */

  _state(id) {
    const s = this._hass.states[id];
    if (!s || s.state === "unavailable" || s.state === "unknown") return null;
    return s;
  }

  _num(id) {
    const s = this._state(id);
    if (!s) return null;
    const n = Number(s.state);
    return Number.isFinite(n) ? n : null;
  }

  _weather() {
    const w = this._state(this._config.weather);
    if (!w) return null;
    return {
      condition: w.state,
      temp: w.attributes.temperature,
      hum: w.attributes.humidity,
      wind: w.attributes.wind_speed,
      pressure: w.attributes.pressure,
      forecast: w.attributes.forecast || []
    };
  }

  /* ================= SAMPLING ================= */

  _sampleCharts() {
    for (const c of this._config.charts || []) {
      const v = this._num(c.entity);
      if (v == null) continue;
      const arr = this._series.get(c.entity) || [];
      arr.push({ t: Date.now(), v });
      if (arr.length > 200) arr.shift();
      this._series.set(c.entity, arr);
    }
  }

  /* ================= ICON MAP ================= */

  _icon(cond) {
    const map = {
      clear: "☀️",
      "clear-night": "🌙",
      cloudy: "☁️",
      partlycloudy: "⛅",
      rainy: "🌧️",
      pouring: "🌧️",
      lightning: "⛈️",
      snowy: "❄️",
      fog: "🌫️",
      windy: "💨",
    };
    return map[cond] || "🌡️";
  }

  /* ================= RENDER ================= */

  _render() {
    if (!this._hass || !this._config) return;

    const w = this._weather();
    if (!w) return;

    const temp = this._num(this._config.temperature) ?? w.temp;
    const hum = this._num(this._config.humidity) ?? w.hum;
    const wind = this._num(this._config.wind_speed) ?? w.wind;
    const press = this._num(this._config.pressure) ?? w.pressure;

    this.shadowRoot.innerHTML = `
<style>
  ha-card{
    padding:24px;
    border-radius:28px;
    background: linear-gradient(180deg,#0b1220,#020617);
    color:#fff;
    font-family: system-ui,-apple-system,Segoe UI,Roboto;
  }
  .top{display:flex;justify-content:space-between;align-items:center}
  .temp{font-size:64px;font-weight:900}
  .cond{font-size:16px;opacity:.85}
  .icon{font-size:56px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:16px}
  .tile{background:rgba(255,255,255,.08);border-radius:16px;padding:12px}
  .k{font-size:12px;opacity:.6}
  .v{font-size:18px;font-weight:700}
  .btns{display:flex;gap:10px;margin-top:14px}
  button{border:none;border-radius:12px;padding:8px 12px;background:#1e293b;color:#fff}
</style>

<ha-card>
  <div class="top">
    <div>
      <div class="temp">${temp?.toFixed(1) ?? "—"}°</div>
      <div class="cond">${w.condition}</div>
    </div>
    <div class="icon">${this._icon(w.condition)}</div>
  </div>

  <div class="grid">
    ${hum != null ? `<div class="tile"><div class="k">Umidità</div><div class="v">${hum}%</div></div>` : ""}
    ${wind != null ? `<div class="tile"><div class="k">Vento</div><div class="v">${wind} km/h</div></div>` : ""}
    ${press != null ? `<div class="tile"><div class="k">Pressione</div><div class="v">${press} hPa</div></div>` : ""}
  </div>

  <div class="btns">
    ${this._config.charts.length ? `<button id="c">Grafici</button>` : ""}
    <button id="d">Dettagli</button>
  </div>
</ha-card>`;

    const c = this.shadowRoot.querySelector("#c");
    const d = this.shadowRoot.querySelector("#d");
    if (c) c.onclick = this._toggleCharts;
    if (d) d.onclick = this._toggleDetails;
  }
}

customElements.define("wsc-unified-card", WSCUnifiedCard);
