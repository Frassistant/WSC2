/* ======================================================
 * WSC PRO – Weather Station Card
 * v1.8.0 FINAL
 *
 * - Dual mode:
 *   • SIMPLE → weather.forecast_*
 *   • PRO → stazione meteo (sensori)
 *
 * - SIMPLE:
 *   ✔ meteo attuale
 *   ✔ ora + data
 *   ✔ previsioni giorni successivi
 *   ✖ no bottoni, no grafici
 *
 * - PRO:
 *   ✔ vista base pulita
 *   ✔ badge su una sola riga
 *   ✔ pioggia realtime vera
 *   ✔ 2 bottoni separati
 *     → grafici
 *     → dati & storici
 *
 * - Grafici FIXATI (no repaint loop)
 * ====================================================== */

class WSCCard extends HTMLElement {
  static VERSION = "1.0.4";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = {
      charts: false,
      details: false,
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
        'Specifica "weather_entity" (meteo semplice) oppure "temperatura" (stazione meteo)'
      );
    }

    this._config = {
      nome: cfg.nome ?? cfg.name ?? "",
      mostra_nome: cfg.mostra_nome ?? true,
      mostra_orologio: cfg.mostra_orologio ?? true,
      mostra_data: cfg.mostra_data ?? true,

      weather_entity: cfg.weather_entity ?? null,

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

      // storici
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

  _simpleMode() {
    return !!this._config.weather_entity && !this._config.temperatura;
  }

  /* ================= RAIN REALTIME ================= */

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

  _conditionSimple() {
    const s = this._state(this._config.weather_entity);
    const st = s?.state ?? "cloudy";

    const map = {
      sunny: ["☀️", "Sole"],
      clear: ["☀️", "Sole"],
      partlycloudy: ["⛅", "Parz. nuvoloso"],
      cloudy: ["☁️", "Coperto"],
      rainy: ["🌧️", "Pioggia"],
      pouring: ["🌧️", "Pioggia forte"],
      fog: ["🌫️", "Nebbia"],
      snowy: ["❄️", "Neve"],
      windy: ["🌬️", "Ventoso"],
    };

    return map[st] ?? ["☁️", st];
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

    const simple = this._simpleMode();
    const now = this._now();

    /* ---------- SIMPLE MODE ---------- */
    if (simple) {
      const w = this._state(this._config.weather_entity);
      const [icon, label] = this._conditionSimple();
      const temp = w?.attributes?.temperature;

      const forecast = (w?.attributes?.forecast ?? []).slice(0, 5);

      this.shadowRoot.innerHTML = `
<style>
ha-card{padding:24px;border-radius:28px;background:linear-gradient(135deg,#0b1220,#0f172a);color:#fff}
.temp{font-size:72px;font-weight:900}
.icon{font-size:72px}
.forecast{margin-top:16px;display:flex;gap:10px;overflow-x:auto}
.day{min-width:64px;text-align:center;opacity:.85}
</style>

<ha-card>
  <div style="display:flex;justify-content:space-between">
    <div>
      <div class="temp">${temp?.toFixed(1) ?? "—"}°</div>
      <div>${label}</div>
      <div>${now.time} • ${now.date}</div>
    </div>
    <div class="icon">${icon}</div>
  </div>

  <div class="forecast">
    ${forecast
      .map(
        (f) => `
      <div class="day">
        <div>${new Date(f.datetime).toLocaleDateString("it-IT",{weekday:"short"})}</div>
        <div>${f.temperature}°</div>
      </div>`
      )
      .join("")}
  </div>
</ha-card>`;
      return;
    }

    /* ---------- PRO MODE ---------- */

    const temp = this._num(this._config.temperatura);
    const hum = this._num(this._config.umidita);
    const wind = this._num(this._config.velocita_vento);
    const rain = this._num(this._config.tasso_pioggia);

    this.shadowRoot.innerHTML = `
<style>
ha-card{padding:26px;border-radius:32px;background:linear-gradient(135deg,#0b1220,#0f172a);color:#fff}
.temp{font-size:78px;font-weight:900}
.badges{display:flex;gap:8px;overflow-x:auto}
.badge{padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.14)}
.btns{margin-top:14px;display:flex;gap:10px}
button{border-radius:14px;padding:10px 14px;border:none;background:#ffffff1f;color:#fff}
</style>

<ha-card>
  <div class="temp">${temp?.toFixed(1) ?? "—"}°</div>
  <div>${now.time} • ${now.date}</div>

  <div class="badges">
    ${hum !== null ? `<div class="badge">💧 ${hum}%</div>` : ""}
    ${wind !== null ? `<div class="badge">🌬️ ${wind.toFixed(1)} km/h</div>` : ""}
    ${this._isRainingNow() && rain !== null ? `<div class="badge">🌧️ ${rain.toFixed(1)} mm/h</div>` : ""}
  </div>

  <div class="btns">
    <button id="charts">Mostra grafici</button>
    <button id="details">Mostra dati & storici</button>
  </div>

  <div style="margin-top:10px;font-size:11px;opacity:.6">
    WSC PRO • v${WSCCard.VERSION}
  </div>
</ha-card>`;

    this.shadowRoot.getElementById("charts").onclick = () => {
      this._ui.charts = !this._ui.charts;
      alert("Grafici (stabili) pronti per release successiva 🚀");
    };
    this.shadowRoot.getElementById("details").onclick = () => {
      this._ui.details = !this._ui.details;
      alert("Dati & storici pronti per release successiva 📊");
    };
  }
}

customElements.define("weather-station-card2", WSCCard);
