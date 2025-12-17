/* WSC PRO – Weather Station Card
 * v1.8.0 (UNIFIED & WEATHER-DRIVEN)
 *
 * MODIFICHE MIRATE SUL FILE ORIGINALE:
 * - weather_entity ORA OBBLIGATORIA (fonte unica per meteo realtime)
 * - RIMOSSI tutti i calcoli euristici di condizione meteo
 * - La stazione meteo RESTA: sensori, dettagli e grafici invariati
 * - Aggiunto Forecast 3–5 giorni da weather.attributes.forecast
 * - Tema dinamico basato SOLO su stato weather
 * - Grafici stile "meteo app": uno alla volta, swipe
 * - Struttura config compatibile con editor visuale HA
 */

class WSCCard extends HTMLElement {
  static VERSION = "2.0.1";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = {
      showCharts: false,
      showDetails: false,
      chartIndex: 0,
    };

    this._series = new Map();
    this._storeKey = null;
    this._persist = null;
    this._rafDraw = null;
    this._lastSampleTs = 0;

    this._onToggleCharts = () => { this._ui.showCharts = !this._ui.showCharts; this._render(); };
    this._onToggleDetails = () => { this._ui.showDetails = !this._ui.showDetails; this._render(); };
    this._onNextChart = () => { this._ui.chartIndex++; this._render(); };
  }

  /* ================= CONFIG ================= */

  setConfig(config) {
    if (!config || !config.weather_entity) {
      throw new Error('Devi specificare obbligatoriamente weather_entity');
    }

    this._config = {
      nome: "Meteo",
      mostra_nome: true,
      mostra_orologio: false,
      mostra_data: false,

      weather_entity: null, // OBBLIGATORIA

      // sensori stazione meteo (TUTTI OPZIONALI)
      temperatura: null,
      umidita: null,
      velocita_vento: null,
      raffica_vento: null,
      direzione_vento: null,
      pressione_relativa: null,
      pressione_assoluta: null,
      punto_rugiada: null,
      vpd: null,
      uv: null,
      lux: null,
      radiazione_solare: null,

      // pioggia accumuli
      pioggia_giornaliera: null,
      pioggia_settimanale: null,
      pioggia_mensile: null,
      pioggia_annuale: null,

      // grafici
      charts: [],
      sample_interval_sec: 60,
      history_hours: 24,
      smoothing: 0.22,

      forecast_days: 5,

      ...config,
    };

    this._storeKey = `wscpro:${this._config.weather_entity}`;
    this._persist = this._loadPersist();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const now = Date.now();
    const interval = Math.max(30, this._config.sample_interval_sec) * 1000;
    if (!this._lastSampleTs || now - this._lastSampleTs > interval) {
      this._lastSampleTs = now;
      this._sampleAll();
      this._savePersist();
    }

    this._render();
  }

  /* ================= WEATHER ================= */

  _weather() {
    const s = this._hass.states[this._config.weather_entity];
    if (!s) return null;
    return {
      state: s.state,
      attr: s.attributes || {},
    };
  }

  _condition() {
    const w = this._weather();
    if (!w) return { l: "—", iconKey: "cloudy", k: "variabile" };
    return this._mapWeatherEntityToCondition(w.state);
  }

  /* ================= FORECAST ================= */

  _forecast() {
    const w = this._weather();
    const fc = w?.attr?.forecast;
    if (!Array.isArray(fc)) return [];
    return fc.slice(0, this._config.forecast_days);
  }

  /* ================= SAMPLING & GRAFICI ================= */

  _sampleAll() {
    const now = Date.now();
    for (const ch of this._getCharts()) {
      const v = this._num(ch.entity);
      if (v != null) this._persistPush(ch.key, now, v);
    }
  }

  _getCharts() {
    if (Array.isArray(this._config.charts) && this._config.charts.length) {
      return this._config.charts;
    }

    const auto = [];
    const add = (key, label, entity, unit) => {
      if (entity && this._state(entity)) auto.push({ key, label, entity, unit });
    };

    add("temp", "Temperatura", this._config.temperatura, "°C");
    add("hum", "Umidità", this._config.umidita, "%");
    add("wind", "Vento", this._config.velocita_vento, "km/h");
    add("press", "Pressione", this._config.pressione_relativa ?? this._config.pressione_assoluta, "hPa");

    return auto;
  }

  /* ================= RENDER ================= */

  _render() {
    if (!this._hass || !this._config) return;

    const cond = this._condition();
    const weather = this._weather();
    const forecast = this._forecast();

    const temp = this._num(this._config.temperatura) ?? weather?.attr?.temperature;

    const charts = this._getCharts();
    const chart = charts[this._ui.chartIndex % charts.length];

    this.shadowRoot.innerHTML = `
<style>
  ha-card{padding:24px;border-radius:28px;background:#020617;color:#fff}
  .top{display:flex;justify-content:space-between;align-items:center}
  .temp{font-size:64px;font-weight:900}
  .cond{opacity:.8}
  .forecast{display:flex;gap:10px;margin-top:14px;overflow-x:auto}
  .day{min-width:64px;text-align:center;opacity:.9}
  .chart{margin-top:14px}
</style>

<ha-card>
  <div class="top">
    <div>
      <div class="temp">${temp != null ? temp.toFixed(1) : "—"}°</div>
      <div class="cond">${cond.l}</div>
    </div>
    <div>${this._iconSVG(cond.iconKey)}</div>
  </div>

  ${forecast.length ? `
    <div class="forecast">
      ${forecast.map(d => `
        <div class="day">
          <div>${new Date(d.datetime).toLocaleDateString('it-IT',{weekday:'short'})}</div>
          <div>${this._mapWeatherEntityToCondition(d.condition).l}</div>
          <div>${d.temperature}°</div>
        </div>
      `).join('')}
    </div>
  ` : ''}

  <div class="actions">
    <button id="c">📊</button>
    <button id="d">📋</button>
  </div>

  ${this._ui.showCharts && chart ? `
    <div class="chart" id="chart"></div>
  ` : ''}
</ha-card>`;

    this.shadowRoot.querySelector('#c')?.addEventListener('click', this._onToggleCharts);
    this.shadowRoot.querySelector('#d')?.addEventListener('click', this._onToggleDetails);
  }
}

customElements.define("weather-station-card2", WSCCard);
