/* WSC PRO – Weather Station Card
 * v1.8.0 (weather-driven + forecast + swipe charts + visual editor)
 *
 * REGOLE (come richiesto):
 * - Meteo realtime (condizione/icone/tema) SOLO da weather_entity (obbligatoria)
 * - Sensori stazione meteo RESTANO (tutti opzionali) per valori, dettagli e grafici
 * - Forecast: giornaliero 3–5 gg + hourly (fino a 24h) da weather.attributes.forecast
 * - Grafici: stile meteo app (1 alla volta) con swipe (touch + mouse) e tap/click
 * - Config visuale: editor (ha-form) + stub config
 */

class WSCCard extends HTMLElement {
  static VERSION = "2.0.2";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = {
      showCharts: false,
      showDetails: false,
      chartIndex: 0,
      forecastMode: "auto", // auto | daily | hourly | both
    };

    // key -> [{t,v}] (RAM)
    this._series = new Map();

    // localStorage
    this._storeKey = null;
    this._persist = null;

    this._rafDraw = null;
    this._lastSampleTs = 0;

    // swipe
    this._swipe = {
      active: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      lockedAxis: null, // "x" | "y"
      pointerId: null,
    };

    this._onToggleCharts = this._onToggleCharts.bind(this);
    this._onToggleDetails = this._onToggleDetails.bind(this);
    this._onNextChart = this._onNextChart.bind(this);
    this._onPrevChart = this._onPrevChart.bind(this);

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  /* ===================== HA hooks ===================== */

  setConfig(config) {
    if (!config) throw new Error("Config mancante");

    // Alias per utenti (inglese -> italiano) così non si rompono le config
    const cfg = { ...config };
    if (cfg.weather && !cfg.weather_entity) cfg.weather_entity = cfg.weather;
    if (cfg.temperature && !cfg.temperatura) cfg.temperatura = cfg.temperature;
    if (cfg.humidity && !cfg.umidita) cfg.umidita = cfg.humidity;
    if (cfg.wind_speed && !cfg.velocita_vento) cfg.velocita_vento = cfg.wind_speed;
    if (cfg.wind_gust && !cfg.raffica_vento) cfg.raffica_vento = cfg.wind_gust;
    if (cfg.wind_direction && !cfg.direzione_vento) cfg.direzione_vento = cfg.wind_direction;
    if (cfg.pressure && !cfg.pressione_relativa && !cfg.pressione_assoluta) cfg.pressione_relativa = cfg.pressure;

    if (!cfg.weather_entity) {
      throw new Error('Devi specificare obbligatoriamente "weather_entity" (es: weather.home)');
    }

    // Defaults + override utente
    this._config = {
      // UI
      nome: "Meteo",
      mostra_nome: true,
      mostra_orologio: false,
      mostra_data: false,

      // required
      weather_entity: null,

      // Sampling & History
      sample_interval_sec: 60,
      history_hours: 24,
      smoothing: 0.22,

      // Forecast
      forecast_days: 5,          // daily cards (se disponibili)
      forecast_hours: 24,        // hourly cards (se disponibili)
      forecast_mode: "auto",     // auto | daily | hourly | both
      forecast_show: true,

      // Charts: se non definiti, auto-detect
      // charts: [{ key:"temp", label:"Temperatura", entity:"sensor.xxx", unit:"°C" }, ...],
      charts: null,

      // SENSORS (tutti opzionali)
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

      // stile
      style: "pro", // pro | glass | minimal (per future estensioni)
      ...cfg,
    };

    this._ui.forecastMode = String(this._config.forecast_mode || "auto");

    // storage key stabile (per più istanze)
    this._storeKey = `wscpro:${this._hash(`${this._config.nome}|${this._config.weather_entity}|${this._config.temperatura || ""}`)}`;
    this._persist = this._loadPersist();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const now = Date.now();
    const interval = Math.max(10, Number(this._config?.sample_interval_sec ?? 60)) * 1000;
    if (!this._lastSampleTs || (now - this._lastSampleTs) >= interval) {
      this._lastSampleTs = now;
      this._sampleAll();
      this._savePersist();
    }

    this._render();
  }

  getCardSize() {
    return (this._ui.showCharts ? 7 : 4) + (this._ui.showDetails ? 6 : 0) + (this._config?.forecast_show ? 2 : 0);
  }

  /* ===================== Helpers ===================== */

  _hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  _state(entityId) {
    if (!entityId) return null;
    const s = this._hass?.states?.[entityId];
    if (!s) return null;
    const v = s.state;
    if (v === "unavailable" || v === "unknown" || v === "" || v == null) return null;
    return s;
  }

  _num(entityId) {
    const s = this._state(entityId);
    if (!s) return null;
    const n = Number(s.state);
    return Number.isFinite(n) ? n : null;
  }

  _esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  _now() {
    const d = new Date();
    return {
      time: d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      date: d.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short" }),
    };
  }

  _clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  _escId(s) {
    return String(s).replace(/[^a-zA-Z0-9_]/g, "_");
  }

  /* ===================== Persisted history ===================== */

  _loadPersist() {
    try {
      const raw = localStorage.getItem(this._storeKey);
      if (!raw) return { series: {}, meta: { v: 1 } };
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return { series: {}, meta: { v: 1 } };
      if (!obj.series) obj.series = {};
      if (!obj.meta) obj.meta = { v: 1 };
      return obj;
    } catch (e) {
      return { series: {}, meta: { v: 1 } };
    }
  }

  _savePersist() {
    try {
      if (!this._persist) return;
      localStorage.setItem(this._storeKey, JSON.stringify(this._persist));
    } catch (e) {
      // ignore quota errors
    }
  }

  _persistPush(key, t, v) {
    if (!Number.isFinite(v)) return;
    if (!this._persist.series[key]) this._persist.series[key] = [];
    const arr = this._persist.series[key];

    arr.push({ t, v });

    const keepMs = Math.max(1, Number(this._config.history_hours ?? 24)) * 3600 * 1000;
    const minT = Date.now() - keepMs;
    while (arr.length && arr[0].t < minT) arr.shift();

    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  }

  _getHistory(key) {
    const arr = this._persist?.series?.[key] ?? [];
    return Array.isArray(arr) ? arr : [];
  }

  /* ===================== WEATHER (single source of truth) ===================== */

  _weatherState() {
    const we = this._config.weather_entity;
    const s = we ? this._state(we) : null;
    return s;
  }

  _weatherAttrs() {
    const s = this._weatherState();
    return s?.attributes || {};
  }

  _mapWeatherEntityToCondition(state) {
    // mapping comune HA: clear-night, clear, cloudy, partlycloudy, rainy, pouring, lightning, lightning-rainy, snowy, snowy-rainy, fog, windy, windy-variant, exceptional
    const s = (state || "").toLowerCase();
    const isNight = s.includes("night") || s === "clear-night";

    if (s.includes("lightning")) return this._cond("temporale", "Temporale", "thunder", "storm", isNight);
    if (s.includes("snowy")) return this._cond("neve", "Neve", "snow", "snow", isNight);
    if (s.includes("fog")) return this._cond(isNight ? "nebbia_notte" : "nebbia", "Nebbia", "fog", "fog", isNight);
    if (s.includes("pour")) return this._cond(isNight ? "pioggia_forte_notte" : "pioggia_forte", "Pioggia forte", "rain_heavy", "rain", isNight);
    if (s.includes("rain")) return this._cond(isNight ? "pioggia_notte" : "pioggia", "Pioggia", "rain", "rain", isNight);
    if (s.includes("cloudy")) return this._cond(isNight ? "coperto_notte" : "coperto", "Coperto", "cloudy", "cloudy", isNight);
    if (s.includes("partly")) return this._cond(isNight ? "parz_nuvoloso_notte" : "parz_nuvoloso", "Parz. nuvoloso", isNight ? "partly_night" : "partly_day", "partly", isNight);
    if (s.includes("clear-night")) return this._cond("sereno_notte", "Sereno (notte)", "clear_night", "clear_night", true);
    if (s === "clear") return this._cond("sereno", "Sereno", "clear_day", "clear", false);
    if (s.includes("wind")) return this._cond(isNight ? "ventoso_notte" : "ventoso", "Ventoso", "wind", "wind", isNight);
    if (s.includes("exceptional")) return this._cond(isNight ? "variabile_notte" : "variabile", "Eccezionale", isNight ? "partly_night" : "partly_day", "special", isNight);

    return this._cond(isNight ? "variabile_notte" : "variabile", "Variabile", isNight ? "partly_night" : "partly_day", "partly", isNight);
  }

  _cond(k, label, iconKey, themeKey, isNight) {
    return { k, l: label, iconKey, themeKey, isNight: !!isNight };
  }

  _condition() {
    const s = this._weatherState();
    const key = s ? String(s.state || "") : "";
    return this._mapWeatherEntityToCondition(key);
  }

  /* ===================== Theme engine (advanced) ===================== */

  _theme(themeKey, isNight) {
    // palette clean (meteo app)
    const t = {
      clear:       ["#07101f", "#0b2a4a", "rgba(56,189,248,.18)"],
      clear_night: ["#050814", "#0A163A", "rgba(147,197,253,.14)"],

      partly:      ["#07101f", "#12324F", "rgba(253,224,71,.12)"],
      cloudy:      ["#060b15", "#101827", "rgba(148,163,184,.12)"],
      wind:        ["#07101f", "#0b1e3a", "rgba(165,180,252,.12)"],
      fog:         ["#070a12", "#121826", "rgba(226,232,240,.10)"],
      rain:        ["#040B18", "#06355F", "rgba(56,189,248,.18)"],
      storm:       ["#050615", "#1A1035", "rgba(168,85,247,.14)"],
      snow:        ["#050814", "#0B1B2E", "rgba(226,232,240,.12)"],
      special:     ["#070B14", "#111827", "rgba(251,113,133,.10)"],
    };

    if (isNight && (themeKey === "clear" || themeKey === "partly")) {
      return t.clear_night;
    }
    return t[themeKey] ?? (isNight ? t.clear_night : t.cloudy);
  }

  _themeDecor(themeKey, isNight) {
    // overlay animations purely CSS
    const rain = (themeKey === "rain" || themeKey === "storm");
    const snow = (themeKey === "snow");
    const fog = (themeKey === "fog");
    const stars = isNight;

    return {
      rain,
      snow,
      fog,
      stars,
      lightning: themeKey === "storm",
    };
  }

  /* ===================== Sampling series ===================== */

  _pushSeries(key, value) {
    if (!Number.isFinite(value)) return;
    const arr = this._series.get(key) ?? [];
    const now = Date.now();
    arr.push({ t: now, v: value });
    while (arr.length > 240) arr.shift();
    this._series.set(key, arr);
  }

  _sampleAll() {
    const now = Date.now();

    // campiona i grafici (auto o user)
    for (const ch of this._getCharts()) {
      const v = this._num(ch.entity);
      if (v !== null) {
        this._pushSeries(ch.key, v);
        this._persistPush(ch.key, now, v);
      }
    }
  }

  _getCharts() {
    const user = this._config.charts;
    if (Array.isArray(user) && user.length) {
      return user
        .filter(x => x && x.key && x.label && x.entity)
        .map(x => ({
          key: String(x.key),
          label: String(x.label),
          entity: String(x.entity),
          unit: x.unit != null ? String(x.unit) : "",
        }));
    }

    const out = [];
    const add = (key, label, entity, unit="") => {
      if (!entity) return;
      if (!this._state(entity)) return;
      out.push({ key, label, entity, unit });
    };

    // auto-detect “meteo app”: pochi ma utili
    add("temp", "Temperatura", this._config.temperatura, "°C");
    add("hum", "Umidità", this._config.umidita, "%");
    add("wind", "Vento", this._config.velocita_vento, "km/h");
    add("press", "Pressione", this._config.pressione_relativa ?? this._config.pressione_assoluta, "hPa");
    add("rain", "Pioggia", this._config.tasso_pioggia, "mm/h");
    add("uv", "UV", this._config.uv, "");

    return out.slice(0, 6);
  }

  /* ===================== Charts render (single + swipe) ===================== */

  _smoothSeries(data, alpha) {
    if (!data || data.length < 3) return data;
    const a = this._clamp(alpha ?? 0.22, 0, 0.5);
    let prev = data[0].v;
    const out = [{ t: data[0].t, v: prev }];
    for (let i = 1; i < data.length; i++) {
      prev = prev + a * (data[i].v - prev);
      out.push({ t: data[i].t, v: prev });
    }
    return out;
  }

  _drawChart(canvas, key, unit) {
    if (!canvas) return;

    const raw = this._getHistory(key);
    if (raw.length < 2) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    ctx.clearRect(0, 0, w, h);

    // downsample
    let data = raw;
    const maxPts = 220;
    if (data.length > maxPts) {
      const step = Math.ceil(data.length / maxPts);
      const ds = [];
      for (let i = 0; i < data.length; i += step) ds.push(data[i]);
      data = ds;
    }

    data = this._smoothSeries(data, this._config.smoothing);

    const vals = data.map(p => p.v);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = (max - min) || 1;

    const padX = 12 * dpr;
    const padY = 10 * dpr;
    const gx0 = padX, gx1 = w - padX;
    const gy0 = padY, gy1 = h - padY;

    // subtle grid
    ctx.globalAlpha = 0.10;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = "#ffffff";
    const gridN = 4;
    for (let i = 1; i < gridN; i++) {
      const y = gy0 + (i / gridN) * (gy1 - gy0);
      ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const X = (i) => gx0 + (i / (data.length - 1)) * (gx1 - gx0);
    const Y = (v) => gy1 - ((v - min) / span) * (gy1 - gy0);

    // area
    const grad = ctx.createLinearGradient(0, gy0, 0, gy1);
    grad.addColorStop(0, "rgba(255,255,255,.18)");
    grad.addColorStop(1, "rgba(255,255,255,.02)");

    ctx.beginPath();
    ctx.moveTo(X(0), Y(data[0].v));
    for (let i = 1; i < data.length; i++) ctx.lineTo(X(i), Y(data[i].v));
    ctx.lineTo(X(data.length - 1), gy1);
    ctx.lineTo(X(0), gy1);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line glow
    ctx.save();
    ctx.lineWidth = 4 * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "#ffffff";
    ctx.shadowColor = "rgba(255,255,255,.35)";
    ctx.shadowBlur = 14 * dpr;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(data[0].v));
    for (let i = 1; i < data.length; i++) ctx.lineTo(X(i), Y(data[i].v));
    ctx.stroke();
    ctx.restore();

    // crisp
    ctx.lineWidth = 2 * dpr;
    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(X(0), Y(data[0].v));
    for (let i = 1; i < data.length; i++) ctx.lineTo(X(i), Y(data[i].v));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // last badge
    const last = data[data.length - 1].v;
    const txt = `${Number.isFinite(last) ? last.toFixed(1) : "—"}${unit ?? ""}`;
    ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    const tw = ctx.measureText(txt).width + 16 * dpr;
    const tx = w - tw - 10 * dpr;
    const ty = 10 * dpr;
    ctx.globalAlpha = 0.20;
    ctx.fillStyle = "#ffffff";
    this._roundRect(ctx, tx, ty, tw, 22 * dpr, 11 * dpr);
    ctx.fill();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = "#000000";
    ctx.fillText(txt, tx + 8 * dpr, ty + 15.5 * dpr);
    ctx.globalAlpha = 1;
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  _scheduleDrawChartSingle(ch) {
    cancelAnimationFrame(this._rafDraw);
    this._rafDraw = requestAnimationFrame(() => {
      if (!this.shadowRoot || !ch) return;
      const el = this.shadowRoot.querySelector(`#wsc_chart_main`);
      if (el) this._drawChart(el, ch.key, ch.unit);
    });
  }

  _onNextChart() {
    const charts = this._getCharts();
    if (!charts.length) return;
    this._ui.chartIndex = (this._ui.chartIndex + 1) % charts.length;
    this._render();
  }

  _onPrevChart() {
    const charts = this._getCharts();
    if (!charts.length) return;
    this._ui.chartIndex = (this._ui.chartIndex - 1 + charts.length) % charts.length;
    this._render();
  }

  _onPointerDown(ev) {
    const wrap = this.shadowRoot?.querySelector(".chartSwipe");
    if (!wrap) return;

    // capture only if in chart area
    if (!(ev.target && wrap.contains(ev.target))) return;

    this._swipe.active = true;
    this._swipe.startX = ev.clientX;
    this._swipe.startY = ev.clientY;
    this._swipe.lastX = ev.clientX;
    this._swipe.lockedAxis = null;
    this._swipe.pointerId = ev.pointerId;

    try { wrap.setPointerCapture(ev.pointerId); } catch (e) {}
  }

  _onPointerMove(ev) {
    if (!this._swipe.active || this._swipe.pointerId !== ev.pointerId) return;

    const dx = ev.clientX - this._swipe.startX;
    const dy = ev.clientY - this._swipe.startY;

    if (!this._swipe.lockedAxis) {
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx > 8 || ady > 8) {
        this._swipe.lockedAxis = (adx > ady) ? "x" : "y";
      } else {
        return;
      }
    }

    if (this._swipe.lockedAxis === "x") {
      // avoid page scroll
      ev.preventDefault?.();
      this._swipe.lastX = ev.clientX;
      const track = this.shadowRoot?.querySelector(".chartTrack");
      if (track) {
        track.style.transform = `translate3d(${this._clamp(dx, -80, 80)}px,0,0)`;
      }
    }
  }

  _onPointerUp(ev) {
    if (!this._swipe.active || this._swipe.pointerId !== ev.pointerId) return;
    this._swipe.active = false;

    const dx = ev.clientX - this._swipe.startX;
    const track = this.shadowRoot?.querySelector(".chartTrack");
    if (track) track.style.transform = `translate3d(0,0,0)`;

    // threshold
    if (Math.abs(dx) > 45) {
      if (dx < 0) this._onNextChart();
      else this._onPrevChart();
    }
  }

  _onToggleCharts() {
    this._ui.showCharts = !this._ui.showCharts;
    this._render();
  }

  _onToggleDetails() {
    this._ui.showDetails = !this._ui.showDetails;
    this._render();
  }

  /* ===================== Forecast (hourly + daily) ===================== */

  _splitForecast() {
    const a = this._weatherAttrs();
    const fc = a?.forecast;
    if (!Array.isArray(fc) || !fc.length) return { hourly: [], daily: [] };

    // prova a distinguere hourly vs daily:
    // - hourly spesso ha molti record (>= 20) ravvicinati
    // - daily tipicamente <= 10
    // - alcuni provider danno solo hourly o solo daily
    // user chooses via forecast_mode, ma auto prova a fare entrambi se ha senso
    const sorted = [...fc].filter(x => x && x.datetime).sort((x,y) => (new Date(x.datetime)) - (new Date(y.datetime)));

    // heuristic SOLO per separazione (non per “meteo realtime”): è ok
    // raggruppo per data
    const byDate = new Map();
    for (const it of sorted) {
      const d = new Date(it.datetime);
      const k = d.toISOString().slice(0,10);
      if (!byDate.has(k)) byDate.set(k, []);
      byDate.get(k).push(it);
    }

    let looksHourly = sorted.length >= 20;
    // se per la prima data ho molte entry, è hourly
    const firstDayKey = sorted[0] ? new Date(sorted[0].datetime).toISOString().slice(0,10) : null;
    if (firstDayKey && (byDate.get(firstDayKey)?.length || 0) >= 8) looksHourly = true;

    const mode = String(this._config.forecast_mode || "auto");
    const wantHourly = (mode === "hourly" || mode === "both" || (mode === "auto" && looksHourly));
    const wantDaily = (mode === "daily" || mode === "both" || mode === "auto");

    let hourly = [];
    let daily = [];

    if (wantHourly) {
      hourly = sorted.slice(0, Math.max(1, Number(this._config.forecast_hours ?? 24)));
    }

    if (wantDaily) {
      // costruisco daily prendendo 1 item per giorno: preferisco quello con temperatura più alta se esiste temperature,
      // altrimenti prendo quello centrale
      const days = [];
      for (const [k, arr] of byDate.entries()) {
        if (!arr.length) continue;
        let pick = arr[Math.floor(arr.length/2)];
        if (arr[0] && typeof arr[0].temperature === "number") {
          pick = arr.reduce((best, cur) => (typeof cur.temperature === "number" && cur.temperature > (best.temperature ?? -1e9)) ? cur : best, pick);
        } else if (arr[0] && typeof arr[0].templow === "number" && typeof arr[0].temperature === "number") {
          // some providers put daily highs/lows
          pick = arr[0];
        }
        days.push(pick);
      }
      daily = days.slice(0, Math.max(1, Number(this._config.forecast_days ?? 5)));
    }

    return { hourly, daily };
  }

  _fmtHour(dt) {
    try {
      const d = new Date(dt);
      return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "—";
    }
  }

  _fmtDay(dt) {
    try {
      const d = new Date(dt);
      return d.toLocaleDateString("it-IT", { weekday: "short" });
    } catch (e) {
      return "—";
    }
  }

  /* ===================== UI bits ===================== */

  _badgeHTML(innerHTML) {
    return `<span class="badge">${innerHTML}</span>`;
  }

  _tile(title, valueHTML, hint = "") {
    if (valueHTML === null || valueHTML === undefined || valueHTML === "") return "";
    return `
      <div class="tile" title="${this._esc(hint)}">
        <div class="k">${this._esc(title)}</div>
        <div class="v">${valueHTML}</div>
      </div>
    `;
  }

  _iconSVG(key) {
    const common = `fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"`;
    const wrap = (inner, cls="") => `
      <svg class="wscSvg ${cls}" viewBox="0 0 64 64" aria-hidden="true">
        ${inner}
      </svg>
    `;

    switch (key) {
      case "clear_day":
        return wrap(`
          <circle cx="32" cy="32" r="10" ${common}></circle>
          <g class="sunRays" ${common}>
            <path d="M32 6v8"/><path d="M32 50v8"/>
            <path d="M6 32h8"/><path d="M50 32h8"/>
            <path d="M12 12l6 6"/><path d="M46 46l6 6"/>
            <path d="M52 12l-6 6"/><path d="M18 46l-6 6"/>
          </g>
        `, "sun");
      case "clear_night":
        return wrap(`
          <path ${common} d="M41 10c-8 2-14 10-14 19 0 11 9 20 20 20 3 0 6-.6 9-1.8-3.2 4.6-8.5 7.6-14.5 7.6-9.7 0-17.5-7.8-17.5-17.5 0-7.1 4.2-13.2 10.5-16.9z"/>
          <g class="stars" ${common} opacity=".8">
            <path d="M50 22l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/>
            <path d="M54 34l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8z"/>
          </g>
        `, "moon");
      case "partly_day":
        return wrap(`
          <g ${common} class="sunBack">
            <circle cx="24" cy="26" r="8"></circle>
            <path d="M24 10v5"/><path d="M24 37v5"/><path d="M8 26h5"/><path d="M35 26h5"/>
          </g>
          <g ${common} class="cloudFront">
            <path d="M18 46h26a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 18 46z"/>
          </g>
        `, "partly");
      case "partly_night":
        return wrap(`
          <g ${common} class="moonBack">
            <path d="M30 14c-5 1-9 6-9 12 0 7 6 13 13 13 2 0 4-.4 6-1.2-2.2 3.2-5.8 5.2-9.8 5.2-6.5 0-11.8-5.3-11.8-11.8 0-4.8 2.8-9 7.1-11.4z"/>
          </g>
          <g ${common} class="cloudFront">
            <path d="M18 46h26a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 18 46z"/>
          </g>
        `, "partly");
      case "cloudy":
        return wrap(`
          <g ${common} class="clouds">
            <path d="M16 44h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 44z"/>
            <path d="M14 52h34a9 9 0 0 0 0-18 12 12 0 0 0-24 2A7 7 0 0 0 14 52z" opacity=".8"/>
          </g>
        `, "cloudy");
      case "drizzle":
      case "rain_light":
        return wrap(`
          <g ${common} class="cloudFront">
            <path d="M16 40h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 40z"/>
          </g>
          <g ${common} class="drops">
            <path d="M22 44v8"/><path d="M32 44v10"/><path d="M42 44v8"/>
          </g>
        `, "rain");
      case "rain":
        return wrap(`
          <g ${common} class="cloudFront">
            <path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 38z"/>
          </g>
          <g ${common} class="drops">
            <path d="M20 42v12"/><path d="M30 42v14"/><path d="M40 42v12"/><path d="M50 42v14" opacity=".0"/>
          </g>
        `, "rain");
      case "rain_heavy":
        return wrap(`
          <g ${common} class="cloudFront">
            <path d="M14 36h34a11 11 0 0 0 0-22 16 16 0 0 0-31 4A9 9 0 0 0 14 36z"/>
          </g>
          <g ${common} class="drops heavy">
            <path d="M18 40v16"/><path d="M28 40v18"/><path d="M38 40v16"/><path d="M48 40v18"/>
          </g>
        `, "rain");
      case "thunder":
        return wrap(`
          <g ${common} class="cloudFront">
            <path d="M14 36h34a11 11 0 0 0 0-22 16 16 0 0 0-31 4A9 9 0 0 0 14 36z"/>
          </g>
          <path class="bolt" d="M30 38l-6 12h8l-4 12 12-16h-8l4-8z" fill="currentColor" opacity=".9"/>
          <g ${common} class="drops">
            <path d="M18 40v14"/><path d="M46 40v14"/>
          </g>
        `, "thunder");
      case "snow":
        return wrap(`
          <g ${common} class="cloudFront">
            <path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 38z"/>
          </g>
          <g ${common} class="flakes">
            <path d="M22 46l0 10"/><path d="M22 51l-3 3"/><path d="M22 51l3 3"/>
            <path d="M32 46l0 12"/><path d="M32 52l-3 3"/><path d="M32 52l3 3"/>
            <path d="M42 46l0 10"/><path d="M42 51l-3 3"/><path d="M42 51l3 3"/>
          </g>
        `, "snow");
      case "fog":
      case "mist":
        return wrap(`
          <g ${common} class="fogLines" opacity=".9">
            <path d="M14 30h36"/><path d="M10 38h44"/><path d="M14 46h36"/>
          </g>
        `, "fog");
      case "wind":
      case "wind_strong":
        return wrap(`
          <g ${common} class="windLines">
            <path d="M10 26h30c6 0 6-8 0-8"/>
            <path d="M10 34h38c6 0 6 8 0 8"/>
            <path d="M10 42h26c6 0 6-8 0-8"/>
          </g>
        `, "wind");
      default:
        return wrap(`<g ${common}><path d="M16 44h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 44z"/></g>`, "cloudy");
    }
  }

  /* ===================== Render ===================== */

  _render() {
    if (!this._hass || !this._config) return;

    const cond = this._condition();
    const now = this._now();

    const attrs = this._weatherAttrs();

    // valore principale: usa sensore stazione se presente, altrimenti weather temperature
    const temp = this._num(this._config.temperatura);
    const tempMain = (temp !== null) ? temp : (Number.isFinite(Number(attrs.temperature)) ? Number(attrs.temperature) : null);

    // sensori (opzionali): se non c'è la stazione, usa attributi weather se disponibili
    const hum = this._num(this._config.umidita);
    const humMain = (hum !== null) ? hum : (Number.isFinite(Number(attrs.humidity)) ? Number(attrs.humidity) : null);

    const wind = this._num(this._config.velocita_vento);
    const windMain = (wind !== null) ? wind : (Number.isFinite(Number(attrs.wind_speed)) ? Number(attrs.wind_speed) : null);

    const press = this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta);
    const pressMain = (press !== null) ? press : (Number.isFinite(Number(attrs.pressure)) ? Number(attrs.pressure) : null);

    const gust = this._num(this._config.raffica_vento);
    const dir = this._num(this._config.direzione_vento);

    const rainRate = this._num(this._config.tasso_pioggia);
    const uv = this._num(this._config.uv);
    const lux = this._num(this._config.lux);
    const solar = this._num(this._config.radiazione_solare);
    const dew = this._num(this._config.punto_rugiada);
    const vpd = this._num(this._config.vpd);

    const tIn = this._num(this._config.temperatura_interna);
    const hIn = this._num(this._config.umidita_interna);

    const rd = this._num(this._config.pioggia_giornaliera);
    const rw = this._num(this._config.pioggia_settimanale);
    const rm = this._num(this._config.pioggia_mensile);
    const ry = this._num(this._config.pioggia_annuale);

    const showName = !!this._config.mostra_nome;
    const showClock = !!this._config.mostra_orologio;
    const showDate = !!this._config.mostra_data;

    const [bgA, bgB, glow] = this._theme(cond.themeKey, cond.isNight);
    const decor = this._themeDecor(cond.themeKey, cond.isNight);

    // Badges (puliti, senza emoji rumorose)
    const badges = [];
    badges.push(this._badgeHTML(`<span class="bIcon">${this._iconSVG(cond.iconKey)}</span><span class="bTxt">${this._esc(cond.l)}</span>`));
    if (humMain !== null) badges.push(this._badgeHTML(`<span class="bMini">Umidità</span><span class="bVal">${Math.round(humMain)}%</span>`));
    if (windMain !== null) badges.push(this._badgeHTML(`<span class="bMini">Vento</span><span class="bVal">${Number(windMain).toFixed(1)} km/h</span>`));
    if (pressMain !== null) badges.push(this._badgeHTML(`<span class="bMini">Press.</span><span class="bVal">${Number(pressMain).toFixed(0)} hPa</span>`));

    const badgeHTML = badges.join("");

    // direction visual
    const dirHTML = (dir === null) ? null : `
      <span class="dirWrap">
        <span class="dir" style="transform:rotate(${dir}deg)">➤</span>
        <span class="dirDeg">${Math.round(dir)}°</span>
      </span>
    `;

    const detailsTiles = [
      this._tile("Raffica vento", gust === null ? null : `${gust.toFixed(1)} km/h`, "Raffica attuale"),
      this._tile("Direzione vento", dirHTML, "Direzione vento"),
      this._tile("Pressione", pressMain === null ? null : `${Number(pressMain).toFixed(1)} hPa`, "Pressione atmosferica"),

      this._tile("Punto di rugiada", dew === null ? null : `${dew.toFixed(1)}°`, "Condensa / saturazione"),
      this._tile("VPD", vpd === null ? null : `${vpd.toFixed(2)} hPa`, "Deficit di pressione di vapore"),
      this._tile("UV", uv === null ? null : `${Math.round(uv)}`, "Indice UV"),
      this._tile("Radiazione", solar === null ? null : `${solar.toFixed(0)} W/m²`, "Radiazione solare"),
      this._tile("Lux", lux === null ? null : `${lux.toFixed(0)}`, "Luminosità"),

      this._tile("Pioggia (rate)", rainRate === null ? null : `${rainRate.toFixed(1)} mm/h`, "Tasso pioggia (sensore)"),
    ].join("");

    const storiciTiles = [
      this._tile("Pioggia oggi", rd === null ? null : `${rd.toFixed(1)} mm`, "Accumulo giornaliero"),
      this._tile("Pioggia sett.", rw === null ? null : `${rw.toFixed(1)} mm`, "Accumulo settimanale"),
      this._tile("Pioggia mese", rm === null ? null : `${rm.toFixed(1)} mm`, "Accumulo mensile"),
      this._tile("Pioggia anno", ry === null ? null : `${ry.toFixed(1)} mm`, "Accumulo annuale"),
    ].join("");

    const internalTiles = [
      this._tile("Temp. interna", tIn === null ? null : `${tIn.toFixed(1)}°`, "Temperatura interna"),
      this._tile("Umid. interna", hIn === null ? null : `${Math.round(hIn)}%`, "Umidità interna"),
    ].join("");

    // charts (single view)
    const charts = this._getCharts();
    const hasCharts = charts.length > 0;
    const chart = hasCharts ? charts[(this._ui.chartIndex % charts.length + charts.length) % charts.length] : null;

    // forecast
    const showForecast = !!this._config.forecast_show;
    const { hourly, daily } = showForecast ? this._splitForecast() : { hourly: [], daily: [] };
    const hasHourly = hourly.length > 0;
    const hasDaily = daily.length > 0;

    const hourlyHTML = hasHourly ? `
      <div class="secTitle">Prossime ore</div>
      <div class="forecastRow">
        ${hourly.map(it => {
          const c = this._mapWeatherEntityToCondition(it.condition);
          const t = (it.temperature != null && it.temperature !== "") ? Number(it.temperature) : null;
          return `
            <div class="fItem">
              <div class="fTop">${this._esc(this._fmtHour(it.datetime))}</div>
              <div class="fIcon">${this._iconSVG(c.iconKey)}</div>
              <div class="fVal">${t === null || !Number.isFinite(t) ? "—" : `${t.toFixed(0)}°`}</div>
            </div>
          `;
        }).join("")}
      </div>
    ` : "";

    const dailyHTML = hasDaily ? `
      <div class="secTitle">Prossimi giorni</div>
      <div class="forecastGrid">
        ${daily.map(it => {
          const c = this._mapWeatherEntityToCondition(it.condition);
          // daily providers may include templow/temperature_low or temphigh/temperature_high
          const hi = (it.temperature != null && it.temperature !== "") ? Number(it.temperature) :
                     (it.temperature_high != null ? Number(it.temperature_high) : (it.temphigh != null ? Number(it.temphigh) : null));
          const lo = (it.temperature_low != null ? Number(it.temperature_low) : (it.templow != null ? Number(it.templow) : null));
          const hiTxt = (hi == null || !Number.isFinite(hi)) ? "—" : `${hi.toFixed(0)}°`;
          const loTxt = (lo == null || !Number.isFinite(lo)) ? "" : `${lo.toFixed(0)}°`;
          return `
            <div class="dItem">
              <div class="dDay">${this._esc(this._fmtDay(it.datetime))}</div>
              <div class="dMid">${this._iconSVG(c.iconKey)}</div>
              <div class="dTemp">
                <span class="dHi">${hiTxt}</span>
                ${loTxt ? `<span class="dLo">${loTxt}</span>` : ``}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    ` : "";

    this.shadowRoot.innerHTML = `
<style>
  :host{ display:block; }

  ha-card{
    position:relative;
    overflow:hidden;
    padding:22px;
    border-radius:28px;
    color:#fff;
    background:
      radial-gradient(900px 560px at 15% 10%, ${glow}, transparent 62%),
      linear-gradient(135deg, ${bgA}, ${bgB});
    box-shadow: 0 22px 60px rgba(0,0,0,.35);
  }

  /* decorative layers */
  .layer{ position:absolute; inset:0; pointer-events:none; z-index:0; }
  .rainLayer{ opacity:${decor.rain ? 0.38 : 0}; transition:opacity .35s ease; }
  .snowLayer{ opacity:${decor.snow ? 0.35 : 0}; transition:opacity .35s ease; }
  .fogLayer{ opacity:${decor.fog ? 0.28 : 0}; transition:opacity .35s ease; }
  .starsLayer{ opacity:${decor.stars ? 0.30 : 0}; transition:opacity .35s ease; }

  .rainLayer:before{
    content:"";
    position:absolute; inset:-50px;
    background:
      repeating-linear-gradient(120deg,
        rgba(255,255,255,.20) 0 1px,
        rgba(255,255,255,0) 1px 14px);
    transform: translate3d(0,0,0);
    animation: rainMove 1.2s linear infinite;
    filter: blur(.2px);
  }
  @keyframes rainMove{
    from{ transform: translate3d(-10px,-20px,0); }
    to{ transform: translate3d(30px,60px,0); }
  }

  .snowLayer:before{
    content:"";
    position:absolute; inset:0;
    background:
      radial-gradient(circle at 20% 30%, rgba(255,255,255,.9) 0 1px, transparent 2px),
      radial-gradient(circle at 60% 10%, rgba(255,255,255,.8) 0 1px, transparent 2px),
      radial-gradient(circle at 80% 40%, rgba(255,255,255,.7) 0 1px, transparent 2px),
      radial-gradient(circle at 35% 70%, rgba(255,255,255,.8) 0 1px, transparent 2px),
      radial-gradient(circle at 70% 80%, rgba(255,255,255,.9) 0 1px, transparent 2px);
    opacity:.8;
    animation: snowFall 2.6s linear infinite;
  }
  @keyframes snowFall{
    from{ transform: translateY(-20px); }
    to{ transform: translateY(40px); }
  }

  .fogLayer:before{
    content:"";
    position:absolute; inset:-20px;
    background:
      radial-gradient(closest-side at 20% 50%, rgba(255,255,255,.10), transparent 65%),
      radial-gradient(closest-side at 80% 60%, rgba(255,255,255,.08), transparent 62%),
      radial-gradient(closest-side at 50% 40%, rgba(255,255,255,.07), transparent 60%);
    filter: blur(10px);
    animation: fogDrift 6s ease-in-out infinite;
  }
  @keyframes fogDrift{
    0%,100%{ transform: translateX(0); }
    50%{ transform: translateX(20px); }
  }

  .starsLayer:before{
    content:"";
    position:absolute; inset:0;
    background:
      radial-gradient(circle at 10% 20%, rgba(255,255,255,.8) 0 1px, transparent 2px),
      radial-gradient(circle at 30% 10%, rgba(255,255,255,.7) 0 1px, transparent 2px),
      radial-gradient(circle at 70% 25%, rgba(255,255,255,.8) 0 1px, transparent 2px),
      radial-gradient(circle at 90% 15%, rgba(255,255,255,.6) 0 1px, transparent 2px),
      radial-gradient(circle at 60% 5%, rgba(255,255,255,.7) 0 1px, transparent 2px);
    animation: starsTwinkle 3.8s ease-in-out infinite;
  }
  @keyframes starsTwinkle{
    0%,100%{ opacity:.7; }
    50%{ opacity:1; }
  }

  /* content stacking */
  ha-card > .content{ position:relative; z-index:2; }

  .top{ display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }
  .left{ min-width:0; }
  .temp{ font-size:66px; font-weight:950; letter-spacing:-1px; line-height:1; }
  .meta{ margin-top:6px; opacity:.88; font-size:13px; }

  .clockLine{
    margin-top:8px;
    display:flex;
    gap:10px;
    align-items:baseline;
    font-weight:900;
    letter-spacing:.2px;
  }
  .clock{
    font-size:24px;
    font-weight:950;
    letter-spacing:1px;
    opacity:.96;
    text-shadow:0 12px 28px rgba(0,0,0,.40);
  }
  .date{
    font-size:14px;
    font-weight:800;
    opacity:.82;
  }

  .icon{
    width:78px;
    height:78px;
    color:#fff;
    filter: drop-shadow(0 16px 26px rgba(0,0,0,.35));
    transform: translate3d(0,0,0);
    animation: floaty 6.5s cubic-bezier(.4,0,.2,1) infinite;
  }
  @keyframes floaty{
    0%,100%{ transform: translate3d(0,0,0) scale(1); }
    50%{ transform: translate3d(0,-9px,0) scale(1.02); }
  }

  /* SVG micro animations */
  .wscSvg.sun .sunRays{ transform-origin: 32px 32px; animation: spin 10s linear infinite; }
  @keyframes spin{ to{ transform: rotate(360deg); } }
  .wscSvg.rain .drops path{ animation: drop 1.3s ease-in-out infinite; }
  .wscSvg.rain .drops path:nth-child(2){ animation-delay:.15s; }
  .wscSvg.rain .drops path:nth-child(3){ animation-delay:.3s; }
  .wscSvg.rain .drops.heavy path{ animation-duration:.95s; }
  @keyframes drop{
    0%{ opacity:.25; transform: translateY(-3px); }
    50%{ opacity:1; transform: translateY(2px); }
    100%{ opacity:.25; transform: translateY(-3px); }
  }
  .wscSvg.thunder .bolt{ animation: flash 2.4s ease-in-out infinite; transform-origin: 32px 44px; }
  @keyframes flash{
    0%,65%,100%{ opacity:.45; transform: scale(1); }
    70%{ opacity:1; transform: scale(1.05); }
    80%{ opacity:.55; transform: scale(1); }
  }
  .wscSvg.wind .windLines{ animation: wind 2.8s ease-in-out infinite; }
  @keyframes wind{ 0%,100%{ transform: translateX(0); opacity:.85; } 50%{ transform: translateX(6px); opacity:1; } }
  .wscSvg.fog .fogLines{ animation: fog 4.2s ease-in-out infinite; }
  @keyframes fog{ 0%,100%{ transform: translateX(0); opacity:.65; } 50%{ transform: translateX(6px); opacity:.95; } }
  .wscSvg.snow .flakes{ animation: snow 2.9s ease-in-out infinite; }
  @keyframes snow{ 0%,100%{ transform: translateY(0); opacity:.75; } 50%{ transform: translateY(4px); opacity:1; } }

  /* badges */
  .badges{
    margin-top:10px;
    display:flex;
    flex-wrap:nowrap;
    gap:8px;
    overflow-x:auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom:2px;
  }
  .badges::-webkit-scrollbar{ display:none; }

  .badge{
    white-space:nowrap;
    background: rgba(255,255,255,.10);
    border:1px solid rgba(255,255,255,.10);
    padding:7px 12px;
    border-radius:999px;
    font-size:12px;
    backdrop-filter: blur(12px);
    display:inline-flex;
    align-items:center;
    gap:10px;
  }
  .bIcon svg{ width:18px; height:18px; opacity:.95; }
  .bTxt{ font-weight:900; letter-spacing:.1px; }
  .bMini{ opacity:.75; font-size:11px; }
  .bVal{ font-weight:900; }

  .actions{
    margin-top:12px;
    display:flex;
    gap:10px;
    flex-wrap:wrap;
    align-items:center;
  }
  .btn{
    border: 1px solid rgba(255,255,255,.16);
    background: rgba(255,255,255,.08);
    color:#fff;
    padding:10px 14px;
    border-radius:14px;
    font-weight:950;
    cursor:pointer;
    user-select:none;
    backdrop-filter: blur(12px);
  }
  .btn.on{ background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.26); }

  /* forecast */
  .secTitle{
    margin-top:14px;
    font-size:12px;
    font-weight:900;
    letter-spacing:.2px;
    opacity:.82;
  }
  .forecastRow{
    margin-top:8px;
    display:flex;
    gap:10px;
    overflow-x:auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width:none;
    padding-bottom:2px;
  }
  .forecastRow::-webkit-scrollbar{ display:none; }
  .fItem{
    min-width:62px;
    text-align:center;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.08);
    border-radius:18px;
    padding:10px 10px 9px;
    backdrop-filter: blur(14px);
  }
  .fTop{ font-size:11px; opacity:.75; font-weight:800; }
  .fIcon svg{ width:22px; height:22px; margin:6px auto 4px; opacity:.95; }
  .fVal{ font-size:14px; font-weight:950; }

  .forecastGrid{
    margin-top:10px;
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap:10px;
  }
  .dItem{
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.08);
    border-radius:18px;
    padding:12px;
    backdrop-filter: blur(14px);
    display:flex;
    flex-direction:column;
    gap:8px;
    align-items:flex-start;
  }
  .dDay{ font-size:12px; font-weight:900; opacity:.82; text-transform:capitalize; }
  .dMid svg{ width:22px; height:22px; opacity:.95; }
  .dTemp{ display:flex; gap:10px; align-items:baseline; }
  .dHi{ font-size:16px; font-weight:950; }
  .dLo{ font-size:12px; opacity:.7; font-weight:900; }

  /* charts single */
  .chartWrap{
    margin-top:14px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.08);
    border-radius:18px;
    padding:12px;
    backdrop-filter: blur(14px);
  }
  .cHead{
    font-size:12px;
    opacity:.84;
    margin-bottom:10px;
    display:flex;
    justify-content:space-between;
    gap:10px;
    align-items:center;
  }
  .cMeta{ opacity:.65; font-weight:900; }
  .chartSwipe{
    position:relative;
    border-radius:14px;
    overflow:hidden;
    touch-action: pan-y; /* allow vertical scroll but handle horizontal swipes */
  }
  .chartTrack{
    transform: translate3d(0,0,0);
    transition: transform .18s ease;
  }
  canvas.spark{ width:100%; height:108px; display:block; }
  .dots{ display:flex; gap:6px; justify-content:center; margin-top:10px; }
  .dot{ width:6px; height:6px; border-radius:999px; background: rgba(255,255,255,.22); }
  .dot.on{ background: rgba(255,255,255,.82); }

  /* details grid */
  .grid{
    margin-top:14px;
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap:12px;
  }
  .tile{
    background: rgba(255,255,255,.10);
    border: 1px solid rgba(255,255,255,.08);
    border-radius:18px;
    padding:14px;
    backdrop-filter: blur(14px);
  }
  .k{ font-size:12px; opacity:.72; font-weight:800; }
  .v{ margin-top:6px; font-size:18px; font-weight:950; }

  .dirWrap{ display:flex; align-items:center; gap:10px; }
  .dir{
    display:inline-block;
    font-size:22px;
    filter: drop-shadow(0 8px 14px rgba(0,0,0,.35));
    transition: transform .6s ease;
  }
  .dirDeg{ font-size:12px; opacity:.75; font-weight:900; }

  .gridInternal{ margin-top:12px; opacity:.92; }
  .gridInternal .tile{ background: rgba(255,255,255,.06); }

  .footer{
    margin-top:12px;
    display:flex;
    justify-content:space-between;
    font-size:11px;
    opacity:.62;
    font-weight:900;
  }

  /* Responsive */
  @media (max-width: 420px) {
    ha-card { padding: 18px; border-radius: 24px; }
    .temp { font-size: 54px; }
    .icon { width:60px; height:60px; }
    canvas.spark{ height:96px; }
  }
</style>

<ha-card>
  <div class="layer starsLayer"></div>
  <div class="layer fogLayer"></div>
  <div class="layer snowLayer"></div>
  <div class="layer rainLayer"></div>

  <div class="content">

    <div class="top">
      <div class="left">
        <div class="temp">${tempMain === null ? "—" : tempMain.toFixed(1)}°</div>
        ${showName ? `<div class="meta">${this._esc(this._config.nome)}</div>` : ""}

        ${(showClock || showDate) ? `
          <div class="clockLine">
            ${showClock ? `<div class="clock">${now.time}</div>` : ""}
            ${showDate ? `<div class="date">${now.date}</div>` : ""}
          </div>
        ` : ""}

        <div class="badges">${badgeHTML}</div>
      </div>

      <div class="icon">${this._iconSVG(cond.iconKey)}</div>
    </div>

    ${showForecast ? (hourlyHTML + dailyHTML) : ""}

    <div class="actions">
      <button class="btn ${this._ui.showCharts ? "on" : ""}" id="wscBtnCharts">Grafici</button>
      <button class="btn ${this._ui.showDetails ? "on" : ""}" id="wscBtnDetails">Dettagli</button>
      ${this._ui.showCharts && hasCharts ? `<button class="btn" id="wscBtnNext">→</button>` : ""}
    </div>

    ${this._ui.showCharts ? `
      <div class="chartWrap">
        ${hasCharts ? `
          <div class="cHead">
            <span>${this._esc(chart.label)}</span>
            <span class="cMeta">${this._esc(chart.unit || "")}</span>
          </div>
          <div class="chartSwipe" id="wscChartSwipe">
            <div class="chartTrack">
              <canvas class="spark" id="wsc_chart_main"></canvas>
            </div>
          </div>
          <div class="dots">
            ${charts.map((_, i) => `<span class="dot ${i === (this._ui.chartIndex % charts.length) ? "on" : ""}"></span>`).join("")}
          </div>
        ` : `
          <div class="cHead">Nessun sensore grafico configurato</div>
        `}
      </div>
    ` : ""}

    ${this._ui.showDetails ? `
      <div class="grid">
        ${detailsTiles}
      </div>

      ${internalTiles.trim() ? `
        <div class="grid gridInternal">
          ${internalTiles}
        </div>
      ` : ""}

      ${storiciTiles.trim() ? `
        <div class="grid">
          ${storiciTiles}
        </div>
      ` : ""}
    ` : ""}

    <div class="footer">
      <div>WSC PRO</div>
      <div>v${WSCCard.VERSION}</div>
    </div>
  </div>
</ha-card>
    `;

    // buttons
    const bC = this.shadowRoot.querySelector("#wscBtnCharts");
    const bD = this.shadowRoot.querySelector("#wscBtnDetails");
    const bN = this.shadowRoot.querySelector("#wscBtnNext");
    if (bC) bC.onclick = this._onToggleCharts;
    if (bD) bD.onclick = this._onToggleDetails;
    if (bN) bN.onclick = this._onNextChart;

    // swipe listeners (touch + mouse)
    const swipe = this.shadowRoot.querySelector("#wscChartSwipe");
    if (swipe) {
      swipe.addEventListener("pointerdown", this._onPointerDown, { passive: true });
      swipe.addEventListener("pointermove", this._onPointerMove, { passive: false });
      swipe.addEventListener("pointerup", this._onPointerUp, { passive: true });
      swipe.addEventListener("pointercancel", this._onPointerUp, { passive: true });
      // tap/click to next
      swipe.addEventListener("click", () => this._onNextChart());
    }

    // draw chart
    if (this._ui.showCharts && chart) this._scheduleDrawChartSingle(chart);
  }

  /* ===================== Visual editor support ===================== */

  static getConfigElement() {
    return document.createElement("wsc-pro-editor");
  }

  static getStubConfig() {
    return {
      weather_entity: "weather.home",
      nome: "Meteo",
      mostra_nome: true,
      mostra_orologio: false,
      mostra_data: false,
      forecast_show: true,
      forecast_mode: "auto",
      forecast_days: 5,
      forecast_hours: 24,
      sample_interval_sec: 60,
      history_hours: 24,
      smoothing: 0.22,
    };
  }
}

/* ===================== Editor (ha-form) ===================== */

class WSCProEditor extends HTMLElement {
  set hass(hass) { this._hass = hass; if (this._config) this._render(); }
  setConfig(config) { this._config = { ...config }; this._render(); }

  _valueChanged(ev) {
    ev.stopPropagation();
    const cfg = ev.detail?.value ? { ...ev.detail.value } : { ...this._config };
    this._config = cfg;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    }));
  }

  _schema() {
    return [
      { name: "weather_entity", selector: { entity: { domain: "weather" } }, required: true },
      { name: "nome", selector: { text: {} } },
      { name: "mostra_nome", selector: { boolean: {} } },
      { name: "mostra_orologio", selector: { boolean: {} } },
      { name: "mostra_data", selector: { boolean: {} } },

      { name: "forecast_show", selector: { boolean: {} } },
      { name: "forecast_mode", selector: { select: { options: [
        { label: "Auto", value: "auto" },
        { label: "Solo giornaliero", value: "daily" },
        { label: "Solo orario (fino a 24h)", value: "hourly" },
        { label: "Entrambi", value: "both" },
      ]}}},
      { name: "forecast_days", selector: { number: { min: 1, max: 7, mode: "box" } } },
      { name: "forecast_hours", selector: { number: { min: 6, max: 48, mode: "box" } } },

      { name: "sample_interval_sec", selector: { number: { min: 10, max: 600, mode: "box" } } },
      { name: "history_hours", selector: { number: { min: 1, max: 168, mode: "box" } } },
      { name: "smoothing", selector: { number: { min: 0, max: 0.5, step: 0.01, mode: "slider" } } },

      // sensori stazione (opzionali)
      { name: "temperatura", selector: { entity: { domain: "sensor" } } },
      { name: "umidita", selector: { entity: { domain: "sensor" } } },
      { name: "velocita_vento", selector: { entity: { domain: "sensor" } } },
      { name: "raffica_vento", selector: { entity: { domain: "sensor" } } },
      { name: "direzione_vento", selector: { entity: { domain: "sensor" } } },
      { name: "pressione_relativa", selector: { entity: { domain: "sensor" } } },
      { name: "pressione_assoluta", selector: { entity: { domain: "sensor" } } },
      { name: "tasso_pioggia", selector: { entity: { domain: "sensor" } } },

      { name: "uv", selector: { entity: { domain: "sensor" } } },
      { name: "lux", selector: { entity: { domain: "sensor" } } },
      { name: "radiazione_solare", selector: { entity: { domain: "sensor" } } },
      { name: "punto_rugiada", selector: { entity: { domain: "sensor" } } },
      { name: "vpd", selector: { entity: { domain: "sensor" } } },

      { name: "temperatura_interna", selector: { entity: { domain: "sensor" } } },
      { name: "umidita_interna", selector: { entity: { domain: "sensor" } } },

      { name: "pioggia_giornaliera", selector: { entity: { domain: "sensor" } } },
      { name: "pioggia_settimanale", selector: { entity: { domain: "sensor" } } },
      { name: "pioggia_mensile", selector: { entity: { domain: "sensor" } } },
      { name: "pioggia_annuale", selector: { entity: { domain: "sensor" } } },
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;
    this.innerHTML = `
      <div style="padding:12px 0;">
        <ha-form
          .hass="${this._hass}"
          .data="${this._config}"
          .schema="${this._schema()}"
        ></ha-form>
      </div>
    `;

    const form = this.querySelector("ha-form");
    if (form) {
      form.addEventListener("value-changed", (e) => this._valueChanged(e));
    }
  }
}

customElements.define("wsc-pro-editor", WSCProEditor);
customElements.define("weather-station-card2", WSCCard);
