/* WSC – Weather Station Card
 * PRO + BASE (auto mode)
 * v1.7.0
 */

class WSCCard extends HTMLElement {
  static VERSION = "1.0.6";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = {
      showCharts: false,
      showDetails: false,
    };

    this._series = new Map();
    this._rafDraw = null;

    this._lastRainEvent = null;
    this._lastRainTs = 0;

    this._onToggleCharts = () => {
      this._ui.showCharts = !this._ui.showCharts;
      this._render();
    };

    this._onToggleDetails = () => {
      this._ui.showDetails = !this._ui.showDetails;
      this._render();
    };
  }

  /* ================= CONFIG ================= */

  setConfig(config) {
    if (!config) throw new Error("Configurazione mancante");

    const isPro = !!config.temperatura;
    const isBase = !!config.weather_entity;

    if (!isPro && !isBase) {
      throw new Error(
        'Devi specificare "temperatura" (PRO) oppure "weather_entity" (BASE)'
      );
    }

    this._config = {
      // mode
      weather_entity: null,

      // UI
      nome: "Meteo",
      mostra_nome: true,
      mostra_orologio: true,
      mostra_data: true,

      // PRO sensors
      temperatura: null,
      umidita: null,
      velocita_vento: null,
      raffica_vento: null,
      direzione_vento: null,

      tasso_pioggia: null,
      pioggia_evento: null,

      radiazione_solare: null,
      lux: null,
      uv: null,

      punto_rugiada: null,
      vpd: null,

      pressione_relativa: null,
      pressione_assoluta: null,

      temperatura_interna: null,
      umidita_interna: null,

      pioggia_giornaliera: null,
      pioggia_settimanale: null,
      pioggia_mensile: null,
      pioggia_annuale: null,

      ...config,
    };

    this._mode = isPro ? "PRO" : "BASE";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (this._mode === "PRO") this._sample();
    this._render();
  }

  /* ================= HELPERS ================= */

  _state(e) {
    if (!e) return null;
    const s = this._hass.states[e];
    if (!s || ["unknown", "unavailable"].includes(s.state)) return null;
    return s;
  }

  _num(e) {
    const s = this._state(e);
    if (!s) return null;
    const n = Number(s.state);
    return Number.isFinite(n) ? n : null;
  }

  _now() {
    const d = new Date();
    return {
      time: d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      date: d.toLocaleDateString("it-IT", {
        weekday: "short",
        day: "2-digit",
        month: "short",
      }),
    };
  }

  /* ================= RAIN ================= */

  _updateRainEvent() {
    const e = this._num(this._config.pioggia_evento);
    if (e === null) return;
    if (this._lastRainEvent !== null && e > this._lastRainEvent) {
      this._lastRainTs = Date.now();
    }
    this._lastRainEvent = e;
  }

  _isRainingNow() {
    const rate = this._num(this._config.tasso_pioggia) ?? 0;
    if (rate > 0.1) return true;
    return Date.now() - this._lastRainTs < 5 * 60 * 1000;
  }

  /* ================= CONDITION ================= */

  _conditionPro() {
    this._updateRainEvent();

    const rain = this._isRainingNow();
    const uv = this._num(this._config.uv) ?? 0;
    const lux = this._num(this._config.lux) ?? 0;
    const solar = this._num(this._config.radiazione_solare) ?? 0;
    const hum = this._num(this._config.umidita) ?? 0;
    const wind = this._num(this._config.velocita_vento) ?? 0;

    const sunny = !rain && (uv >= 1 || solar >= 90 || lux >= 4000);
    if (rain) return { l: "Pioggia", i: "🌧️" };
    if (sunny) return { l: "Sole", i: "☀️" };
    if (wind >= 25) return { l: "Ventoso", i: "🌬️" };
    if (hum >= 92) return { l: "Nebbia", i: "🌫️" };
    return { l: "Coperto", i: "☁️" };
  }

  _conditionBase() {
    const w = this._state(this._config.weather_entity);
    return {
      l: w?.state ?? "",
      i: w?.attributes?.icon ?? "☁️",
    };
  }

  /* ================= SERIES ================= */

  _push(k, v) {
    if (!Number.isFinite(v)) return;
    const a = this._series.get(k) ?? [];
    a.push(v);
    while (a.length > 120) a.shift();
    this._series.set(k, a);
  }

  _sample() {
    this._push("temp", this._num(this._config.temperatura));
    this._push("wind", this._num(this._config.velocita_vento));
    this._push("rain", this._num(this._config.tasso_pioggia));
  }

  /* ================= RENDER ================= */

  _render() {
    if (!this._hass || !this._config) return;

    const now = this._now();

    /* ===== BASE ===== */
    if (this._mode === "BASE") {
      const w = this._state(this._config.weather_entity);
      const temp = w?.attributes?.temperature;

      const forecast = w?.attributes?.forecast ?? [];

      this.shadowRoot.innerHTML = `
<style>
ha-card{
  padding:22px;
  border-radius:28px;
  background:linear-gradient(135deg,#0b1220,#0f172a);
  color:#fff;
}
.temp{font-size:64px;font-weight:900}
.time{margin-top:6px;font-size:14px;opacity:.85}
.forecast{margin-top:14px;display:flex;gap:10px}
.day{flex:1;text-align:center;font-size:12px}
</style>

<ha-card>
  <div class="temp">${temp ?? "—"}°</div>
  <div class="time">${now.time} • ${now.date}</div>

  <div class="forecast">
    ${forecast.slice(0, 4).map(f => `
      <div class="day">
        ${f.temperature}°
      </div>`).join("")}
  </div>

  <div style="opacity:.6;font-size:11px;margin-top:10px">
    WSC • BASE
  </div>
</ha-card>
      `;
      return;
    }

    /* ===== PRO ===== */

    const cond = this._conditionPro();
    const temp = this._num(this._config.temperatura);
    const hum = this._num(this._config.umidita);
    const wind = this._num(this._config.velocita_vento);
    const rain = this._isRainingNow()
      ? this._num(this._config.tasso_pioggia)
      : null;

    this.shadowRoot.innerHTML = `
<style>
ha-card{
  padding:26px;
  border-radius:32px;
  background:linear-gradient(135deg,#0b1220,#0f172a);
  color:#fff;
}
.temp{font-size:72px;font-weight:900}
.badges{display:flex;gap:8px;margin-top:10px}
.badge{padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.15)}
.actions{margin-top:14px;display:flex;gap:10px}
.btn{padding:10px 14px;border-radius:14px;background:rgba(255,255,255,.12);cursor:pointer}
.grid{margin-top:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.tile{background:rgba(255,255,255,.12);padding:14px;border-radius:16px}
</style>

<ha-card>
  <div class="temp">${temp?.toFixed(1) ?? "—"}°</div>
  <div>${now.time} • ${now.date}</div>

  <div class="badges">
    <div class="badge">${cond.i} ${cond.l}</div>
    ${hum !== null ? `<div class="badge">💧 ${hum}%</div>` : ""}
    ${wind !== null ? `<div class="badge">🌬️ ${wind.toFixed(1)} km/h</div>` : ""}
    ${rain !== null ? `<div class="badge">🌧️ ${rain.toFixed(1)} mm/h</div>` : ""}
  </div>

  <div class="actions">
    <div class="btn" id="charts">Mostra grafici</div>
    <div class="btn" id="details">Mostra dati & storici</div>
  </div>

  ${this._ui.showDetails ? `
    <div class="grid">
      <div class="tile">VPD<br>${this._num(this._config.vpd)?.toFixed(2) ?? "—"} hPa</div>
    </div>` : ""}

  <div style="opacity:.6;font-size:11px;margin-top:10px">
    WSC • PRO v${WSCCard.VERSION}
  </div>
</ha-card>
    `;

    this.shadowRoot.querySelector("#charts")?.addEventListener("click", this._onToggleCharts);
    this.shadowRoot.querySelector("#details")?.addEventListener("click", this._onToggleDetails);
  }
}

customElements.define("weather-station-card", WSCCard);
