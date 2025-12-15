/* ==========================================================
 * WSC – Weather Station Card
 * v2.0.0 – FINAL
 * Modalità automatica:
 *  - BASE → weather.forecast_home
 *  - PRO  → stazione meteo (sensori)
 * ========================================================== */

class WSCCard extends HTMLElement {
  static VERSION = "1.0.7";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = {
      showCharts: false,
      showDetails: false,
    };

    this._series = new Map();
    this._raf = null;

    this._lastRainEvent = null;
    this._lastRainTs = 0;

    this._onCharts = () => {
      this._ui.showCharts = !this._ui.showCharts;
      this._render();
    };

    this._onDetails = () => {
      this._ui.showDetails = !this._ui.showDetails;
      this._render();
    };
  }

  /* ================= CONFIG ================= */

  setConfig(config) {
    if (!config.weather && !config.temperatura) {
      throw new Error(
        'Devi specificare "weather" (BASE) oppure "temperatura" (PRO)'
      );
    }

    this._config = {
      // BASE
      weather: null,

      // UI
      nome: "Stazione Meteo",
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
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._sample();
    this._render();
  }

  getCardSize() {
    return this._config.weather
      ? 4
      : 4 + (this._ui.showCharts ? 4 : 0) + (this._ui.showDetails ? 6 : 0);
  }

  /* ================= HELPERS ================= */

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
      time: d.toLocaleTimeString("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
      }),
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

  /* ================= SERIES ================= */

  _push(k, v) {
    if (!Number.isFinite(v)) return;
    const a = this._series.get(k) ?? [];
    a.push({ t: Date.now(), v });
    while (a.length > 120) a.shift();
    this._series.set(k, a);
  }

  _sample() {
    if (!this._config.temperatura) return;
    this._push("temp", this._num(this._config.temperatura));
    this._push("wind", this._num(this._config.velocita_vento));
    this._push("rain", this._num(this._config.tasso_pioggia));
  }

  _draw(canvas, key) {
    const d = this._series.get(key);
    if (!canvas || !d || d.length < 2) return;

    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = canvas.clientHeight * devicePixelRatio;

    ctx.clearRect(0, 0, w, h);

    const vals = d.map(p => p.v);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;

    ctx.beginPath();
    d.forEach((p, i) => {
      const x = (i / (d.length - 1)) * w;
      const y = h - ((p.v - min) / span) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  /* ================= RENDER ================= */

  _render() {
    if (!this._hass || !this._config) return;

    const now = this._now();
    const isBase = !!this._config.weather;
    const isPro = !!this._config.temperatura;

    /* ---------- BASE ---------- */
    if (isBase) {
      const w = this._state(this._config.weather);
      if (!w) return;

      const f = w.attributes.forecast ?? [];
      const icon = w.state;

      this.shadowRoot.innerHTML = `
        <style>
          ha-card{
            padding:26px;
            border-radius:32px;
            background:linear-gradient(135deg,#0b1220,#0f172a);
            color:#fff;
          }
          .temp{font-size:72px;font-weight:900}
          .meta{margin-top:6px;font-size:14px;opacity:.85}
          .icon{font-size:72px;margin-top:10px}
          .forecast{margin-top:14px;display:flex;gap:10px;overflow-x:auto}
          .day{min-width:80px;text-align:center;opacity:.85}
        </style>
        <ha-card>
          <div class="temp">${w.attributes.temperature}°</div>
          <div class="meta">${now.time} • ${now.date}</div>
          <div class="icon">${this._icon(icon)}</div>

          <div class="forecast">
            ${f.slice(0,5).map(d=>`
              <div class="day">
                <div>${new Date(d.datetime).toLocaleDateString("it-IT",{weekday:"short"})}</div>
                <div>${this._icon(d.condition)}</div>
                <div>${Math.round(d.temperature)}°</div>
              </div>`).join("")}
          </div>

          <div style="opacity:.5;font-size:11px;margin-top:10px">WSC • BASE</div>
        </ha-card>`;
      return;
    }

    /* ---------- PRO ---------- */
    const temp = this._num(this._config.temperatura);
    const hum = this._num(this._config.umidita);
    const wind = this._num(this._config.velocita_vento);
    const rain = this._num(this._config.tasso_pioggia);
    const raining = this._isRainingNow();

    this.shadowRoot.innerHTML = `
      <style>
        ha-card{
          padding:26px;
          border-radius:32px;
          background:linear-gradient(135deg,#0b1220,#0f172a);
          color:#fff;
        }
        .temp{font-size:72px;font-weight:900}
        .meta{opacity:.8}
        .badges{margin-top:10px;display:flex;gap:8px}
        .badge{background:rgba(255,255,255,.14);padding:6px 12px;border-radius:999px}
        .btns{margin-top:12px;display:flex;gap:10px}
        .btn{background:rgba(255,255,255,.14);padding:10px 14px;border-radius:14px;cursor:pointer}
        .charts{margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px}
        canvas{width:100%;height:70px}
      </style>

      <ha-card>
        <div class="temp">${temp?.toFixed(1) ?? "—"}°</div>
        <div class="meta">${now.time} • ${now.date}</div>

        <div class="badges">
          ${hum!==null?`<span class="badge">💧 ${hum}%</span>`:""}
          ${wind!==null?`<span class="badge">🌬️ ${wind.toFixed(1)} km/h</span>`:""}
          ${raining && rain!==null?`<span class="badge">🌧️ ${rain.toFixed(1)} mm/h</span>`:""}
        </div>

        <div class="btns">
          <div class="btn" id="bCharts">Mostra grafici</div>
          <div class="btn" id="bDetails">Mostra dati & storici</div>
        </div>

        ${this._ui.showCharts?`
          <div class="charts">
            <canvas id="cTemp"></canvas>
            <canvas id="cWind"></canvas>
          </div>`:""}

        <div style="opacity:.5;font-size:11px;margin-top:10px">
          WSC • PRO v${WSCCard.VERSION}
        </div>
      </ha-card>
      `;

    this.shadowRoot.querySelector("#bCharts").onclick = this._onCharts;
    this.shadowRoot.querySelector("#bDetails").onclick = this._onDetails;

    if (this._ui.showCharts) {
      requestAnimationFrame(()=>{
        this._draw(this.shadowRoot.querySelector("#cTemp"),"temp");
        this._draw(this.shadowRoot.querySelector("#cWind"),"wind");
      });
    }
  }

  _icon(cond){
    const m={
      sunny:"☀️",cloudy:"☁️",rainy:"🌧️",
      partlycloudy:"⛅",fog:"🌫️",snowy:"❄️"
    };
    return m[cond]||"☁️";
  }
}

customElements.define("weather-station-card2", WSCCard);
