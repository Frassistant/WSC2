class WSCCard extends HTMLElement {
  static VERSION = "1.0.0";

  constructor() {
    super();
    this._hass = null;
    this._config = null;
    this._ui = { showCharts: false, showDetails: false };
    this._series = new Map();
    this._lastRainEvent = null;
    this._lastRainTs = 0;
  }

  setConfig(config) {
    if (!config.temperatura && !config.weather_entity) {
      throw new Error(
        'Devi specificare "temperatura" oppure "weather_entity"'
      );
    }

    this._config = {
      nome: "",
      mostra_nome: true,
      mostra_orologio: true,
      mostra_data: true,
      ...config,
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  /* =========================
     UTIL
  ========================= */

  _isSimple() {
    return !!this._config.weather_entity;
  }

  _state(e) {
    const s = this._hass?.states?.[e];
    if (!s || ["unavailable", "unknown"].includes(s.state)) return null;
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

  /* =========================
     METEO SEMPLICE
  ========================= */

  _renderSimple() {
    const w = this._hass.states[this._config.weather_entity];
    if (!w) return;

    const iconMap = {
      clear: "☀️",
      sunny: "☀️",
      partlycloudy: "⛅",
      cloudy: "☁️",
      rainy: "🌧️",
      pouring: "🌧️",
      snowy: "❄️",
      fog: "🌫️",
      windy: "🌬️",
    };

    const icon = iconMap[w.state] || "☁️";
    const now = this._now();

    this.shadowRoot.innerHTML = `
<style>
ha-card{
  padding:26px;
  border-radius:32px;
  color:#fff;
  background: linear-gradient(135deg,#0b1220,#0f172a);
}
.temp{font-size:72px;font-weight:900}
.icon{font-size:72px;animation:float 6s ease-in-out infinite}
@keyframes float{
  0%,100%{transform:translateY(0)}
  50%{transform:translateY(-10px)}
}
.meta{opacity:.85;margin-top:6px}
</style>

<ha-card>
  <div style="display:flex;justify-content:space-between">
    <div>
      <div class="temp">${w.attributes.temperature?.toFixed(1) ?? "—"}°</div>
      <div class="meta">
        ${this._config.mostra_orologio ? now.time : ""}
        ${this._config.mostra_data ? " • " + now.date : ""}
      </div>
      <div class="meta">${w.state}</div>
    </div>
    <div class="icon">${icon}</div>
  </div>
</ha-card>
`;
  }

  /* =========================
     METEO STAZIONE (PRO)
  ========================= */

  _isRaining() {
    const rate = this._num(this._config.tasso_pioggia) ?? 0;
    return rate > 0.1;
  }

  _condition() {
    const rain = this._isRaining();
    const hum = this._num(this._config.umidita) ?? 0;
    const lux = this._num(this._config.lux) ?? 0;

    if (rain) return { i: "🌧️", l: "Pioggia" };
    if (lux > 4000) return { i: "☀️", l: "Sole" };
    if (hum > 80) return { i: "☁️", l: "Coperto" };
    return { i: "⛅", l: "Parz. nuvoloso" };
  }

  _renderPro() {
    const t = this._num(this._config.temperatura);
    const h = this._num(this._config.umidita);
    const w = this._num(this._config.velocita_vento);
    const r = this._num(this._config.tasso_pioggia);
    const vpd = this._num(this._config.vpd);
    const now = this._now();
    const c = this._condition();

    this.shadowRoot.innerHTML = `
<style>
ha-card{
  padding:26px;
  border-radius:32px;
  color:#fff;
  background: linear-gradient(135deg,#0b1220,#102a43);
}
.temp{font-size:72px;font-weight:900}
.badges{display:flex;gap:8px;overflow-x:auto}
.badge{background:rgba(255,255,255,.15);padding:6px 12px;border-radius:999px}
.icon{font-size:72px;animation:float 6s ease-in-out infinite}
@keyframes float{
  0%,100%{transform:translateY(0)}
  50%{transform:translateY(-8px)}
}
.buttons{margin-top:14px;display:flex;gap:10px}
button{
  background:rgba(255,255,255,.15);
  border:none;color:#fff;
  padding:10px 14px;
  border-radius:14px;
  font-weight:700;
}
</style>

<ha-card>
  <div style="display:flex;justify-content:space-between">
    <div>
      <div class="temp">${t?.toFixed(1) ?? "—"}°</div>
      <div class="meta">
        ${this._config.mostra_orologio ? now.time : ""}
        ${this._config.mostra_data ? " • " + now.date : ""}
      </div>
      <div class="badges">
        <div class="badge">${c.i} ${c.l}</div>
        ${h !== null ? `<div class="badge">💧 ${h}%</div>` : ""}
        ${w !== null ? `<div class="badge">🌬️ ${w.toFixed(1)} km/h</div>` : ""}
        ${this._isRaining() ? `<div class="badge">🌧️ ${r.toFixed(1)} mm/h</div>` : ""}
      </div>
    </div>
    <div class="icon">${c.i}</div>
  </div>

  <div class="buttons">
    <button>Mostra grafici</button>
    <button>Mostra dati & storici</button>
  </div>

  <div style="margin-top:10px;font-size:11px;opacity:.6">
    WSC PRO • v${WSCCard.VERSION}
  </div>
</ha-card>
`;
  }

  /* ========================= */

  _render() {
    if (!this._hass || !this._config) return;
    if (this._isSimple()) this._renderSimple();
    else this._renderPro();
  }
}

customElements.define("weather-station-card2", WSCCard);
