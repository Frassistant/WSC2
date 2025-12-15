/* ======================================================
 * WSC PRO – Weather Station Card
 * v2.0.0
 * ======================================================
 * Dual Mode:
 *  - SIMPLE → weather.forecast_*
 *  - PRO → stazione meteo completa
 *
 * Designed for:
 *  ✔ mobile
 *  ✔ tablet
 *  ✔ dashboard
 *  ✔ badge-like cards
 * ====================================================== */

class WSCCard extends HTMLElement {
  static VERSION = "1.0.4";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = {
      showCharts: false,
      showDetails: false,
    };

    this._series = new Map();
    this._lastRainEvent = null;
    this._lastRainTs = 0;
    this._raf = null;
    this._pending = false;
  }

  /* ================= CONFIG ================= */

  setConfig(cfg) {
    if (!cfg.weather_entity && !cfg.temperatura) {
      throw new Error(
        'Devi specificare "weather_entity" oppure "temperatura"'
      );
    }

    this._config = {
      name: cfg.name ?? cfg.nome ?? "",
      weather_entity: cfg.weather_entity ?? null,

      // PRO sensors
      temperatura: cfg.temperatura ?? null,
      umidita: cfg.umidita ?? null,
      velocita_vento: cfg.velocita_vento ?? null,
      raffica_vento: cfg.raffica_vento ?? null,
      direzione_vento: cfg.direzione_vento ?? null,
      tasso_pioggia: cfg.tasso_pioggia ?? null,
      pioggia_evento: cfg.pioggia_evento ?? null,
      radiazione_solare: cfg.radiazione_solare ?? null,
      lux: cfg.lux ?? null,
      uv: cfg.uv ?? null,
      punto_rugiada: cfg.punto_rugiada ?? null,
      vpd: cfg.vpd ?? null,
      pressione_relativa: cfg.pressione_relativa ?? null,
      pressione_assoluta: cfg.pressione_assoluta ?? null,
      pioggia_giornaliera: cfg.pioggia_giornaliera ?? null,
      pioggia_mensile: cfg.pioggia_mensile ?? null,
      pioggia_annuale: cfg.pioggia_annuale ?? null,
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._scheduleRender();
  }

  /* ================= UTILS ================= */

  _state(e) {
    const s = this._hass?.states?.[e];
    if (!s || ["unknown", "unavailable", ""].includes(s.state)) return null;
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

  _isSimple() {
    return !!this._config.weather_entity && !this._config.temperatura;
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
    this._updateRainEvent();
    const rate = this._num(this._config.tasso_pioggia) ?? 0;
    return rate > 0.1 || Date.now() - this._lastRainTs < 5 * 60 * 1000;
  }

  /* ================= METEO ================= */

  _simpleCondition(state) {
    const map = {
      sunny: ["☀️", "Sole"],
      clear: ["☀️", "Sereno"],
      partlycloudy: ["⛅", "Parz. nuvoloso"],
      cloudy: ["☁️", "Coperto"],
      rainy: ["🌧️", "Pioggia"],
      pouring: ["🌧️", "Pioggia forte"],
      fog: ["🌫️", "Nebbia"],
      snowy: ["❄️", "Neve"],
      windy: ["🌬️", "Ventoso"],
    };
    return map[state] ?? ["☁️", state];
  }

  /* ================= SCHEDULER ================= */

  _scheduleRender() {
    if (this._pending) return;
    this._pending = true;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      this._pending = false;
      this._render();
    });
  }

  /* ================= RENDER ================= */

  _render() {
    if (!this._hass || !this._config) return;

    const now = this._now();
    const simple = this._isSimple();

    /* =====================================================
     * SIMPLE MODE
     * ===================================================== */
    if (simple) {
      const w = this._state(this._config.weather_entity);
      const [icon, label] = this._simpleCondition(w?.state);
      const temp = w?.attributes?.temperature;
      const forecast = (w?.attributes?.forecast ?? []).slice(0, 5);

      this.shadowRoot.innerHTML = `
<style>
ha-card{
  padding:22px;
  border-radius:26px;
  background:linear-gradient(135deg,#0b1220,#0f172a);
  color:#fff;
}
.header{display:flex;justify-content:space-between}
.temp{font-size:64px;font-weight:900}
.icon{font-size:64px;animation:float 6s ease-in-out infinite}
@keyframes float{50%{transform:translateY(-8px)}}
.forecast{display:flex;gap:10px;margin-top:16px;overflow-x:auto}
.day{text-align:center;min-width:60px;opacity:.85}
</style>

<ha-card>
  <div class="header">
    <div>
      <div class="temp">${temp?.toFixed(1) ?? "—"}°</div>
      <div>${label}</div>
      <div>${now.time} • ${now.date}</div>
    </div>
    <div class="icon">${icon}</div>
  </div>

  <div class="forecast">
    ${forecast.map(f => `
      <div class="day">
        <div>${new Date(f.datetime).toLocaleDateString("it-IT",{weekday:"short"})}</div>
        <div>${f.temperature}°</div>
      </div>`).join("")}
  </div>
</ha-card>`;
      return;
    }

    /* =====================================================
     * PRO MODE
     * ===================================================== */

    const t = this._num(this._config.temperatura);
    const h = this._num(this._config.umidita);
    const w = this._num(this._config.velocita_vento);
    const r = this._num(this._config.tasso_pioggia);

    this.shadowRoot.innerHTML = `
<style>
ha-card{
  padding:26px;
  border-radius:32px;
  background:linear-gradient(135deg,#0b1220,#0f172a);
  color:#fff;
}
.temp{font-size:72px;font-weight:900}
.badges{display:flex;gap:8px;overflow-x:auto;margin-top:6px}
.badge{padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.14)}
.btns{display:flex;gap:10px;margin-top:14px}
button{padding:10px 14px;border-radius:14px;border:none;background:#ffffff1f;color:#fff}
.footer{margin-top:12px;font-size:11px;opacity:.6;display:flex;justify-content:space-between}
</style>

<ha-card>
  <div class="temp">${t?.toFixed(1) ?? "—"}°</div>
  <div>${now.time} • ${now.date}</div>

  <div class="badges">
    ${h !== null ? `<div class="badge">💧 ${h}%</div>` : ""}
    ${w !== null ? `<div class="badge">🌬️ ${w.toFixed(1)} km/h</div>` : ""}
    ${this._isRainingNow() && r !== null ? `<div class="badge">🌧️ ${r.toFixed(1)} mm/h</div>` : ""}
  </div>

  <div class="btns">
    <button id="charts">Mostra grafici</button>
    <button id="details">Mostra dati & storici</button>
  </div>

  <div class="footer">
    <div>WSC PRO</div>
    <div>v${WSCCard.VERSION}</div>
  </div>
</ha-card>`;

    this.shadowRoot.getElementById("charts").onclick = () =>
      alert("Grafici PRO pronti per v2.1 🚀");

    this.shadowRoot.getElementById("details").onclick = () =>
      alert("Dati & storici PRO pronti per v2.1 📊");
  }
}

customElements.define("weather-station-card2", WSCCard);
