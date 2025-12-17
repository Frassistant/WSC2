/* WSC PRO – Weather Station Card
 * Premium Unified Edition
 * v2.3.0
 *
 * ✅ weather_entity required
 * ✅ Weather-only mode (only weather_entity configured): shows current + weather attribute badges + daily forecast + hourly forecast
 * ✅ Station mode (any station sensor configured): shows buttons (SVG), charts (swipe), details & storics
 * ✅ Interactive charts: pan (drag), zoom (wheel), tooltip; X=time, Y=value
 * ✅ Visual editor (ha-form) + stub config
 *
 * Meteo realtime (condizione/tema/icone) ALWAYS from weather_entity.
 */
(() => {
  const CARD_TAG = "weather-station-card2";
  const EDITOR_TAG = "wsc-pro-editor";

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const fmtNum = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");
  const isNil = (v) => v === null || v === undefined;

  class WSCCard extends HTMLElement {
    static VERSION = "2.0.5";

    static getConfigElement() {
      return document.createElement(EDITOR_TAG);
    }
    static getStubConfig() {
      return {
        nome: "Meteo",
        weather_entity: "",
        mostra_nome: true,
        mostra_orologio: true,
        mostra_data: true,
        forecast_days: 5,
        forecast_hours: 24,
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;

      this._ui = { showCharts: false, showDetails: false, chartIndex: 0 };

      this._storeKey = null;
      this._persist = null;

      this._chartState = new Map(); // key -> {scale, offset, hoverI, dragging, lastX}
      this._rafDraw = 0;

      this._lastSampleTs = 0;

      this._onToggleCharts = () => { this._ui.showCharts = !this._ui.showCharts; this._render(); };
      this._onToggleDetails = () => { this._ui.showDetails = !this._ui.showDetails; this._render(); };
      this._onPrevChart = () => { this._ui.chartIndex = Math.max(0, this._ui.chartIndex - 1); this._render(); };
      this._onNextChart = () => { this._ui.chartIndex = this._ui.chartIndex + 1; this._render(); };
    }

    setConfig(config) {
      if (!config || !config.weather_entity) {
        throw new Error('Devi specificare obbligatoriamente "weather_entity"');
      }

      // alias mapping (english -> italian keys)
      const map = {
        weather: "weather_entity",
        temperature: "temperatura",
        humidity: "umidita",
        wind_speed: "velocita_vento",
        wind_gust: "raffica_vento",
        wind_bearing: "direzione_vento",
        rain_rate: "tasso_pioggia",
        pressure: "pressione_relativa",
      };
      const cfg = { ...config };
      for (const [from, to] of Object.entries(map)) {
        if (!isNil(cfg[from]) && isNil(cfg[to])) cfg[to] = cfg[from];
      }

      this._config = {
        // UI
        nome: "Meteo",
        mostra_nome: true,
        mostra_orologio: true,
        mostra_data: true,

        // weather
        weather_entity: null,
        forecast_days: 5,
        forecast_hours: 24,

        // station sensors (optional)
        temperatura: null,
        umidita: null,
        velocita_vento: null,
        raffica_vento: null,
        direzione_vento: null,
        tasso_pioggia: null,
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

        // charts
        charts: [],
        sample_interval_sec: 60,
        history_hours: 24,
        smoothing: 0.22,

        ...cfg,
      };

      this._storeKey = `wscpro:${this._hash(`${this._config.nome}|${this._config.weather_entity}|${this._config.temperatura || ""}`)}`;
      this._persist = this._loadPersist();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });

      const now = Date.now();
      const interval = Math.max(15, Number(this._config?.sample_interval_sec ?? 60)) * 1000;
      if (!this._lastSampleTs || (now - this._lastSampleTs) >= interval) {
        this._lastSampleTs = now;
        this._sampleAll();
        this._savePersist();
      }

      this._render();
    }

    getCardSize() {
      const station = this._hasStation();
      const base = 5 + (this._hasForecastDaily() ? 3 : 0) + (this._hasForecastHourly() ? 3 : 0);
      if (!station) return base;
      return base + (this._ui.showCharts ? 6 : 0) + (this._ui.showDetails ? 7 : 0);
    }

    /* ============== helpers ============== */

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
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    }

    _now() {
      const d = new Date();
      return {
        time: d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
        date: d.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short" }),
      };
    }

    /* ============== weather ============== */

    _weather() {
      const s = this._state(this._config.weather_entity);
      if (!s) return null;
      return {
        state: String(s.state || "").toLowerCase(),
        rawState: String(s.state || ""),
        attr: s.attributes || {},
      };
    }

    _hasForecastDaily() {
      const w = this._weather();
      return Array.isArray(w?.attr?.forecast) && w.attr.forecast.length > 0;
    }

    _hasForecastHourly() {
      return this._hasForecastDaily() && (Number(this._config.forecast_hours ?? 0) > 0);
    }

    _forecastDaily(days) {
      const w = this._weather();
      const fc = w?.attr?.forecast;
      if (!Array.isArray(fc)) return [];
      return fc.slice(0, clamp(Number(days || 0), 0, 7));
    }

    _forecastHourly(hours) {
      const w = this._weather();
      const fc = w?.attr?.forecast;
      if (!Array.isArray(fc)) return [];
      const limit = clamp(Number(hours || 0), 0, 48);
      if (!limit) return [];
      return fc.slice(0, limit);
    }

    _mapWeatherEntityToCondition(state) {
      const s = (state || "").toLowerCase();
      if (s.includes("lightning")) return { l: "Temporale", iconKey: "thunder", theme: "storm" };
      if (s.includes("snow")) return { l: "Neve", iconKey: "snow", theme: "snow" };
      if (s.includes("fog")) return { l: "Nebbia", iconKey: "fog", theme: "fog" };
      if (s.includes("pour")) return { l: "Pioggia forte", iconKey: "rain_heavy", theme: "rain" };
      if (s.includes("rain")) return { l: "Pioggia", iconKey: "rain", theme: "rain" };
      if (s.includes("cloudy")) return { l: "Coperto", iconKey: "cloudy", theme: "cloudy" };
      if (s.includes("partly")) return { l: "Parz. nuvoloso", iconKey: "partly_day", theme: "partly" };
      if (s.includes("clear-night")) return { l: "Sereno (notte)", iconKey: "clear_night", theme: "night" };
      if (s.includes("clear")) return { l: "Sereno", iconKey: "clear_day", theme: "sun" };
      if (s.includes("wind")) return { l: "Ventoso", iconKey: "wind", theme: "windy" };
      return { l: "Variabile", iconKey: "partly_day", theme: "partly" };
    }

    _theme(themeKey) {
      const t = {
        sun:   { a: "#0b1220", b: "#0b2a4a", glow: "rgba(56,189,248,.22)", accent: "rgba(253,224,71,.20)" },
        night: { a: "#050814", b: "#0a163a", glow: "rgba(147,197,253,.18)", accent: "rgba(167,139,250,.18)" },
        rain:  { a: "#050b18", b: "#06355f", glow: "rgba(34,211,238,.22)", accent: "rgba(56,189,248,.20)" },
        storm: { a: "#070a1a", b: "#1a1035", glow: "rgba(168,85,247,.20)", accent: "rgba(250,204,21,.14)" },
        snow:  { a: "#050814", b: "#0b1b2e", glow: "rgba(226,232,240,.18)", accent: "rgba(255,255,255,.18)" },
        fog:   { a: "#060812", b: "#121826", glow: "rgba(226,232,240,.12)", accent: "rgba(148,163,184,.14)" },
        windy: { a: "#040814", b: "#0b1e3a", glow: "rgba(165,180,252,.14)", accent: "rgba(129,140,248,.16)" },
        cloudy:{ a: "#070b14", b: "#0b1220", glow: "rgba(148,163,184,.14)", accent: "rgba(226,232,240,.10)" },
        partly:{ a: "#070b14", b: "#101e3a", glow: "rgba(148,163,184,.14)", accent: "rgba(253,224,71,.10)" },
      };
      return t[themeKey] ?? t.partly;
    }

    /* ============== station detection ============== */

    _hasStation() {
      const c = this._config;
      const keys = [
        "temperatura","umidita","velocita_vento","raffica_vento","direzione_vento","tasso_pioggia",
        "radiazione_solare","lux","uv","punto_rugiada","vpd","pressione_relativa","pressione_assoluta",
        "temperatura_interna","umidita_interna","pioggia_giornaliera","pioggia_settimanale","pioggia_mensile","pioggia_annuale"
      ];
      if (keys.some(k => !!c[k])) return true;
      return Array.isArray(c.charts) && c.charts.length > 0;
    }

    /* ============== persist ============== */

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
      try { localStorage.setItem(this._storeKey, JSON.stringify(this._persist)); } catch (e) {}
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

    /* ============== sampling / charts ============== */

    _getCharts() {
      const user = this._config.charts;
      if (Array.isArray(user) && user.length) {
        return user
          .filter(x => x && x.key && x.label && x.entity)
          .map(x => ({ key: String(x.key), label: String(x.label), entity: String(x.entity), unit: x.unit != null ? String(x.unit) : "" }));
      }

      const out = [];
      const add = (key, label, entity, unit="") => {
        if (!entity) return;
        if (!this._state(entity)) return;
        out.push({ key, label, entity, unit });
      };
      add("temp", "Temperatura", this._config.temperatura, "°C");
      add("hum", "Umidità", this._config.umidita, "%");
      add("wind", "Vento", this._config.velocita_vento, "km/h");
      add("rain", "Pioggia", this._config.tasso_pioggia, "mm/h");
      add("press", "Pressione", this._config.pressione_relativa ?? this._config.pressione_assoluta, "hPa");
      add("uv", "UV", this._config.uv, "");
      return out.slice(0, 6);
    }

    _sampleAll() {
      const now = Date.now();
      for (const ch of this._getCharts()) {
        const v = this._num(ch.entity);
        if (v != null) this._persistPush(ch.key, now, v);
      }
    }

    /* ============== icons ============== */

    _iconSVG(key) {
      const common = `fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"`;
      const wrap = (inner, cls="") => `<svg class="wscSvg ${cls}" viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;
      switch (key) {
        case "clear_day":
          return wrap(`<circle cx="32" cy="32" r="10" ${common}></circle><g class="sunRays" ${common}><path d="M32 6v8"/><path d="M32 50v8"/><path d="M6 32h8"/><path d="M50 32h8"/><path d="M12 12l6 6"/><path d="M46 46l6 6"/><path d="M52 12l-6 6"/><path d="M18 46l-6 6"/></g>`, "sun");
        case "clear_night":
          return wrap(`<path ${common} d="M41 10c-8 2-14 10-14 19 0 11 9 20 20 20 3 0 6-.6 9-1.8-3.2 4.6-8.5 7.6-14.5 7.6-9.7 0-17.5-7.8-17.5-17.5 0-7.1 4.2-13.2 10.5-16.9z"/><g class="stars" ${common} opacity=".8"><path d="M50 22l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/><path d="M54 34l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8z"/></g>`, "moon");
        case "partly_day":
          return wrap(`<g ${common} class="sunBack"><circle cx="24" cy="26" r="8"></circle><path d="M24 10v5"/><path d="M24 37v5"/><path d="M8 26h5"/><path d="M35 26h5"/></g><g ${common} class="cloudFront"><path d="M18 46h26a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 18 46z"/></g>`, "partly");
        case "cloudy":
          return wrap(`<g ${common} class="clouds"><path d="M16 44h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 44z"/><path d="M14 52h34a9 9 0 0 0 0-18 12 12 0 0 0-24 2A7 7 0 0 0 14 52z" opacity=".8"/></g>`, "cloudy");
        case "rain":
          return wrap(`<g ${common} class="cloudFront"><path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 38z"/></g><g ${common} class="drops"><path d="M20 42v12"/><path d="M30 42v14"/><path d="M40 42v12"/></g>`, "rain");
        case "rain_heavy":
          return wrap(`<g ${common} class="cloudFront"><path d="M14 36h34a11 11 0 0 0 0-22 16 16 0 0 0-31 4A9 9 0 0 0 14 36z"/></g><g ${common} class="drops heavy"><path d="M18 40v16"/><path d="M28 40v18"/><path d="M38 40v16"/><path d="M48 40v18"/></g>`, "rain");
        case "thunder":
          return wrap(`<g ${common} class="cloudFront"><path d="M14 36h34a11 11 0 0 0 0-22 16 16 0 0 0-31 4A9 9 0 0 0 14 36z"/></g><path class="bolt" d="M30 38l-6 12h8l-4 12 12-16h-8l4-8z" fill="currentColor" opacity=".9"/><g ${common} class="drops"><path d="M18 40v14"/><path d="M46 40v14"/></g>`, "thunder");
        case "snow":
          return wrap(`<g ${common} class="cloudFront"><path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 38z"/></g><g ${common} class="flakes"><path d="M22 46l0 10"/><path d="M22 51l-3 3"/><path d="M22 51l3 3"/><path d="M32 46l0 12"/><path d="M32 52l-3 3"/><path d="M32 52l3 3"/><path d="M42 46l0 10"/><path d="M42 51l-3 3"/><path d="M42 51l3 3"/></g>`, "snow");
        case "fog":
          return wrap(`<g ${common} class="fogLines" opacity=".9"><path d="M14 30h36"/><path d="M10 38h44"/><path d="M14 46h36"/></g>`, "fog");
        case "wind":
          return wrap(`<g ${common} class="windLines"><path d="M10 26h30c6 0 6-8 0-8"/><path d="M10 34h38c6 0 6 8 0 8"/><path d="M10 42h26c6 0 6-8 0-8"/></g>`, "wind");
        default:
          return wrap(`<g ${common}><path d="M16 44h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 44z"/></g>`, "cloudy");
      }
    }

    _btnIcon(kind) {
      const common = `fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"`;
      if (kind === "charts") {
        return `<svg viewBox="0 0 24 24" class="btnIco" aria-hidden="true"><path ${common} d="M4 19V5"/><path ${common} d="M4 19h16"/><path ${common} d="M7 16l4-6 3 4 5-8"/><circle cx="7" cy="16" r="1.3" fill="currentColor"/><circle cx="11" cy="10" r="1.3" fill="currentColor"/><circle cx="14" cy="14" r="1.3" fill="currentColor"/><circle cx="19" cy="6" r="1.3" fill="currentColor"/></svg>`;
      }
      if (kind === "details") {
        return `<svg viewBox="0 0 24 24" class="btnIco" aria-hidden="true"><path ${common} d="M5 7h14"/><path ${common} d="M5 12h14"/><path ${common} d="M5 17h10"/><circle cx="19" cy="17" r="1.2" fill="currentColor"/></svg>`;
      }
      if (kind === "left") return `<svg viewBox="0 0 24 24" class="btnIco" aria-hidden="true"><path ${common} d="M15 18l-6-6 6-6"/></svg>`;
      if (kind === "right") return `<svg viewBox="0 0 24 24" class="btnIco" aria-hidden="true"><path ${common} d="M9 6l6 6-6 6"/></svg>`;
      return "";
    }

    /* ============== badges/tiles ============== */

    _badge(text) { return `<span class="badge">${this._esc(text)}</span>`; }

    _tile(title, value, hint = "") {
      if (value === null || value === undefined || value === "") return "";
      return `<div class="tile" title="${this._esc(hint)}"><div class="k">${this._esc(title)}</div><div class="v">${value}</div></div>`;
    }

    /* ============== chart interaction ============== */

    _getChartState(key) {
      if (!this._chartState.has(key)) this._chartState.set(key, { scale: 1, offset: 0, hoverI: null, dragging: false, lastX: 0 });
      return this._chartState.get(key);
    }

    _visibleSlice(raw, canvas, st) {
      const n = raw.length;
      if (n < 2) return { start: 0, end: n - 1 };
      const viewN = Math.max(20, Math.floor(n / st.scale));
      let end = n - 1;
      let start = Math.max(0, end - viewN);
      const w = canvas.clientWidth || 1;
      const ptsPerPx = viewN / Math.max(1, w);
      const shift = Math.round(-st.offset * ptsPerPx);
      start = clamp(start + shift, 0, n - 2);
      end = clamp(end + shift, start + 1, n - 1);
      return { start, end };
    }

    _indexFromX(raw, canvas, x, st) {
      const dpr = devicePixelRatio || 1;
      const w = canvas.clientWidth * dpr;
      const padX = 14 * dpr;
      const usable = Math.max(1, w - padX * 2);
      const { start, end } = this._visibleSlice(raw, canvas, st);
      const len = end - start;
      const t = clamp((x * dpr - padX) / usable, 0, 1);
      return start + Math.round(t * len);
    }

    _bindChartInteractions(canvas, key, unit) {
      const st = this._getChartState(key);

      const onPointerDown = (e) => {
        st.dragging = true;
        st.lastX = e.clientX;
        try { canvas.setPointerCapture(e.pointerId); } catch {}
      };
      const onPointerMove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (st.dragging) {
          const dx = e.clientX - st.lastX;
          st.lastX = e.clientX;
          st.offset += dx;
          this._scheduleDrawChart(canvas, key, unit);
          return;
        }
        const raw = this._getHistory(key);
        if (!raw.length) return;
        st.hoverI = this._indexFromX(raw, canvas, x, st);
        this._scheduleDrawChart(canvas, key, unit);
      };
      const onPointerUp = () => { st.dragging = false; };
      const onWheel = (e) => {
        e.preventDefault();
        const delta = Math.sign(e.deltaY);
        const z = delta > 0 ? 1.12 : 0.9;
        st.scale = clamp(st.scale * z, 1, 8);
        this._scheduleDrawChart(canvas, key, unit);
      };

      const wrap = canvas.closest(".chartWrap");
      if (wrap && !wrap._wscSwipeBound) {
        wrap._wscSwipeBound = true;
        let sx = 0, dx = 0, active = false;
        wrap.addEventListener("pointerdown", (e) => { active = true; sx = e.clientX; dx = 0; }, { passive: true });
        wrap.addEventListener("pointermove", (e) => { if (!active) return; dx = e.clientX - sx; }, { passive: true });
        wrap.addEventListener("pointerup", () => {
          if (!active) return;
          active = false;
          if (Math.abs(dx) > 55) { if (dx < 0) this._onNextChart(); else this._onPrevChart(); }
        }, { passive: true });
      }

      canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
      canvas.addEventListener("pointermove", onPointerMove, { passive: true });
      canvas.addEventListener("pointerup", onPointerUp, { passive: true });
      canvas.addEventListener("pointercancel", onPointerUp, { passive: true });
      canvas.addEventListener("mouseleave", () => { st.hoverI = null; this._scheduleDrawChart(canvas, key, unit); }, { passive: true });
      canvas.addEventListener("wheel", onWheel, { passive: false });
    }

    _scheduleDrawChart(canvas, key, unit) {
      cancelAnimationFrame(this._rafDraw);
      this._rafDraw = requestAnimationFrame(() => this._drawChart(canvas, key, unit));
    }

    _smoothSeries(data, alpha) {
      if (!data || data.length < 3) return data;
      const a = clamp(alpha ?? 0.22, 0, 0.5);
      let prev = data[0].v;
      const out = [{ t: data[0].t, v: prev }];
      for (let i = 1; i < data.length; i++) {
        prev = prev + a * (data[i].v - prev);
        out.push({ t: data[i].t, v: prev });
      }
      return out;
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

    _drawChart(canvas, key, unit) {
      const raw = this._getHistory(key);
      if (!canvas || raw.length < 2) return;

      const st = this._getChartState(key);
      const ctx = canvas.getContext("2d", { alpha: true });

      const dpr = devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      ctx.clearRect(0, 0, w, h);

      const { start, end } = this._visibleSlice(raw, canvas, st);
      let data = raw.slice(start, end + 1);
      const maxPts = 260;
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

      const padX = 44 * dpr;
      const padY = 18 * dpr;
      const gx0 = padX, gx1 = w - 14 * dpr;
      const gy0 = 10 * dpr, gy1 = h - padY - 16 * dpr;

      const X = (i) => gx0 + (i / (data.length - 1)) * (gx1 - gx0);
      const Y = (v) => gy1 - ((v - min) / span) * (gy1 - gy0);

      // grid
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1 * dpr;
      const gridN = 4;
      for (let i = 0; i <= gridN; i++) {
        const y = gy0 + (i / gridN) * (gy1 - gy0);
        ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke();
      }
      ctx.globalAlpha = 1;

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

      // line
      ctx.save();
      ctx.lineWidth = 4.5 * dpr;
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

      ctx.lineWidth = 2.2 * dpr;
      ctx.globalAlpha = 0.92;
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(X(0), Y(data[0].v));
      for (let i = 1; i < data.length; i++) ctx.lineTo(X(i), Y(data[i].v));
      ctx.stroke();
      ctx.globalAlpha = 1;

      // axes
      ctx.font = `${10 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillStyle = "rgba(255,255,255,.65)";

      ctx.textAlign = "right";
      for (let i = 0; i <= 3; i++) {
        const v = min + (span / 3) * i;
        ctx.fillText(v.toFixed(1), gx0 - 8 * dpr, Y(v) + 3 * dpr);
      }

      ctx.textAlign = "center";
      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const idx = Math.floor(i * (data.length - 1) / steps);
        const t = new Date(data[idx].t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
        ctx.fillText(t, X(idx), gy1 + 18 * dpr);
      }

      // hover tooltip
      if (st.hoverI != null) {
        const rawIdx = clamp(st.hoverI, 0, raw.length - 1);
        const targetT = raw[rawIdx].t;
        let best = 0, bestD = Infinity;
        for (let i = 0; i < data.length; i++) {
          const d = Math.abs(data[i].t - targetT);
          if (d < bestD) { bestD = d; best = i; }
        }
        const p = data[best];
        const x = X(best);
        const y = Y(p.v);

        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.moveTo(x, gy0); ctx.lineTo(x, gy1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(x, y, 3.8 * dpr, 0, Math.PI * 2); ctx.fill();

        const time = new Date(p.t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
        const text = `${time} • ${p.v.toFixed(1)}${unit ?? ""}`;
        ctx.font = `${11 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
        const tw = ctx.measureText(text).width + 14 * dpr;
        const bx = clamp(x - tw / 2, gx0, gx1 - tw);
        const by = gy0 + 6 * dpr;
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = "#ffffff";
        this._roundRect(ctx, bx, by, tw, 22 * dpr, 11 * dpr);
        ctx.fill();
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = "#000000";
        ctx.fillText(text, bx + tw / 2, by + 15.2 * dpr);
        ctx.globalAlpha = 1;
      }
    }

    /* ============== render ============== */

    _render() {
      if (!this._hass || !this._config) return;

      const w = this._weather();
      if (!w) {
        this.shadowRoot.innerHTML = `<ha-card style="padding:16px">Weather entity non disponibile</ha-card>`;
        return;
      }

      const cond = this._mapWeatherEntityToCondition(w.state);
      const theme = this._theme(cond.theme);
      const now = this._now();

      const stationMode = this._hasStation();
      const weatherOnly = !stationMode;

      // temperature: station sensor OR weather attr
      const tempFromWeather = Number(w.attr.temperature);
      const temp = this._num(this._config.temperatura) ?? (Number.isFinite(tempFromWeather) ? tempFromWeather : null);

      // Weather-only badges: show ALL available weather attributes
      const wb = [];
      const a = w.attr || {};
      const addWB = (txt) => wb.push(this._badge(txt));

      // common weather attrs
      if (a.humidity != null && a.humidity !== "") addWB(`💧 ${Math.round(Number(a.humidity))}%`);
      if (a.wind_speed != null && a.wind_speed !== "") addWB(`🌬 ${fmtNum(Number(a.wind_speed), 1)} km/h`);
      if (a.wind_gust_speed != null && a.wind_gust_speed !== "") addWB(`💨 ${fmtNum(Number(a.wind_gust_speed), 1)} km/h`);
      if (a.wind_bearing != null && a.wind_bearing !== "") addWB(`🧭 ${a.wind_bearing}${typeof a.wind_bearing === "number" ? "°" : ""}`);
      if (a.pressure != null && a.pressure !== "") addWB(`⏱ ${fmtNum(Number(a.pressure), 0)} hPa`);
      if (a.visibility != null && a.visibility !== "") addWB(`👁 ${fmtNum(Number(a.visibility), 0)} km`);
      if (a.precipitation != null && a.precipitation !== "") addWB(`🌧 ${fmtNum(Number(a.precipitation), 1)} mm`);
      if (a.dew_point != null && a.dew_point !== "") addWB(`💠 ${fmtNum(Number(a.dew_point), 1)}°`);
      if (a.uv_index != null && a.uv_index !== "") addWB(`☀️ UV ${fmtNum(Number(a.uv_index), 0)}`);

      // Station badges: always include condition + optional rain/hum/wind. (pressure NOT here)
      const sb = [];
      sb.push(this._badge(cond.l));
      const rainRate = this._num(this._config.tasso_pioggia);
      if (rainRate != null && rainRate > 0) sb.push(this._badge(`🌧 ${rainRate.toFixed(1)} mm/h`));
      const hum = this._num(this._config.umidita);
      if (hum != null) sb.push(this._badge(`💧 ${Math.round(hum)}%`));
      const wind = this._num(this._config.velocita_vento);
      if (wind != null) sb.push(this._badge(`🌬 ${wind.toFixed(1)} km/h`));

      const badgesHTML = (weatherOnly ? [this._badge(cond.l), ...wb] : sb).join("");

      const daily = this._forecastDaily(clamp(Number(this._config.forecast_days ?? 5), 0, 7));
      const hourly = this._forecastHourly(this._config.forecast_hours);

      const dailyHTML = daily.length ? `
        <div class="sectionTitle">Prossimi giorni</div>
        <div class="forecastRow">
          ${daily.map(d => {
            const dt = d.datetime || d.datetime_iso || d.time || d.date;
            const day = dt ? new Date(dt).toLocaleDateString("it-IT", { weekday: "short" }) : "—";
            const c = this._mapWeatherEntityToCondition(d.condition || "");
            const tHi = d.temperature ?? d.temphigh ?? d.high_temperature ?? d.temp ?? null;
            const tLo = d.templow ?? d.temperature_low ?? d.low_temperature ?? null;
            const hi = tHi != null ? `${Math.round(Number(tHi))}°` : "—";
            const lo = tLo != null ? `${Math.round(Number(tLo))}°` : "";
            return `
              <div class="fcDay">
                <div class="fcD">${this._esc(day)}</div>
                <div class="fcI">${this._iconSVG(c.iconKey)}</div>
                <div class="fcT">${hi}${lo ? `<span class="fcLo">${lo}</span>` : ""}</div>
              </div>`;
          }).join("")}
        </div>` : "";

      const hourlyHTML = hourly.length ? `
        <div class="sectionTitle">Prossime ore</div>
        <div class="forecastRow hourly">
          ${hourly.map(d => {
            const dt = d.datetime || d.datetime_iso || d.time;
            const hh = dt ? new Date(dt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "—";
            const c = this._mapWeatherEntityToCondition(d.condition || "");
            const t = d.temperature ?? d.temp ?? null;
            const tt = t != null ? `${Math.round(Number(t))}°` : "—";
            return `
              <div class="fcHour">
                <div class="fcH">${this._esc(hh)}</div>
                <div class="fcI small">${this._iconSVG(c.iconKey)}</div>
                <div class="fcT">${tt}</div>
              </div>`;
          }).join("")}
        </div>` : "";

      // Station details tiles
      const gust = this._num(this._config.raffica_vento);
      const dir = this._num(this._config.direzione_vento);
      const press = this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta);
      const dew = this._num(this._config.punto_rugiada);
      const vpd = this._num(this._config.vpd);
      const uvS = this._num(this._config.uv);
      const luxS = this._num(this._config.lux);
      const solar = this._num(this._config.radiazione_solare);

      const tIn = this._num(this._config.temperatura_interna);
      const hIn = this._num(this._config.umidita_interna);

      const rd = this._num(this._config.pioggia_giornaliera);
      const rw = this._num(this._config.pioggia_settimanale);
      const rm = this._num(this._config.pioggia_mensile);
      const ry = this._num(this._config.pioggia_annuale);

      const dirHTML = (dir == null) ? null : `<span class="dirWrap"><span class="dir" style="transform:rotate(${dir}deg)">➤</span><span class="dirDeg">${Math.round(dir)}°</span></span>`;

      const detailsTiles = [
        this._tile("Raffica vento", gust == null ? null : `${gust.toFixed(1)} km/h`),
        this._tile("Direzione vento", dirHTML),
        this._tile("Pressione", press == null ? null : `${press.toFixed(1)} hPa`),
        this._tile("Punto di rugiada", dew == null ? null : `${dew.toFixed(1)}°`),
        this._tile("VPD", vpd == null ? null : `${vpd.toFixed(2)} hPa`),
        this._tile("UV", uvS == null ? null : `${Math.round(uvS)}`),
        this._tile("Radiazione", solar == null ? null : `${solar.toFixed(0)} W/m²`),
        this._tile("Lux", luxS == null ? null : `${luxS.toFixed(0)}`),
      ].join("");

      const internalTiles = [
        this._tile("Temp. interna", tIn == null ? null : `${tIn.toFixed(1)}°`),
        this._tile("Umid. interna", hIn == null ? null : `${Math.round(hIn)}%`),
      ].join("");

      const storiciTiles = [
        this._tile("Pioggia oggi", rd == null ? null : `${rd.toFixed(1)} mm`),
        this._tile("Pioggia sett.", rw == null ? null : `${rw.toFixed(1)} mm`),
        this._tile("Pioggia mese", rm == null ? null : `${rm.toFixed(1)} mm`),
        this._tile("Pioggia anno", ry == null ? null : `${ry.toFixed(1)} mm`),
      ].join("");

      const showName = !!this._config.mostra_nome;
      const showClock = !!this._config.mostra_orologio;
      const showDate = !!this._config.mostra_data;

      // Charts
      const charts = this._getCharts();
      const idx = charts.length ? (this._ui.chartIndex % charts.length + charts.length) % charts.length : 0;
      const active = charts[idx];
      const dotsHTML = charts.length ? `<div class="dots" aria-hidden="true">${charts.map((_, i) => `<span class="dot ${i===idx?"on":""}"></span>`).join("")}</div>` : "";

      const chartHTML = (stationMode && this._ui.showCharts && active) ? `
        <div class="chartWrap">
          <div class="chartTop">
            <div class="chartTitle">${this._esc(active.label)}</div>
            <div class="chartMeta">${this._esc(active.unit || "")}</div>
          </div>
          <canvas class="spark" id="wsc_chart_canvas"></canvas>
          ${dotsHTML}
          <div class="chartNav">
            <button class="navBtn" id="wscPrev">${this._btnIcon("left")}</button>
            <div class="navHint">Trascina = scorrimento • Rotella = zoom • Swipe = cambia grafico</div>
            <button class="navBtn" id="wscNext">${this._btnIcon("right")}</button>
          </div>
        </div>` : "";

      const overlays = `
        <div class="overlay overlay-${this._esc(cond.theme)}"></div>
        ${cond.theme === "rain" ? `<div class="rain" aria-hidden="true"></div>` : ""}
        ${cond.theme === "snow" ? `<div class="snow" aria-hidden="true"></div>` : ""}
        ${cond.theme === "night" ? `<div class="stars" aria-hidden="true"></div>` : ""}
      `;

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
      radial-gradient(900px 560px at 15% 10%, ${theme.glow}, transparent 62%),
      linear-gradient(135deg, ${theme.a}, ${theme.b});
    box-shadow: 0 26px 70px rgba(0,0,0,.36);
  }
  .overlay{ position:absolute; inset:0; pointer-events:none; opacity:.55; mix-blend-mode: screen; }
  .overlay-sun{ background: radial-gradient(600px 420px at 22% 18%, ${theme.accent}, transparent 62%); }
  .overlay-partly,.overlay-cloudy{ background: radial-gradient(700px 520px at 20% 16%, rgba(148,163,184,.16), transparent 64%); }
  .overlay-rain{ background: radial-gradient(700px 520px at 22% 18%, rgba(56,189,248,.16), transparent 64%); }
  .overlay-storm{ background: radial-gradient(700px 520px at 22% 18%, rgba(168,85,247,.18), transparent 64%); }
  .overlay-snow{ background: radial-gradient(700px 520px at 22% 18%, rgba(255,255,255,.12), transparent 64%); }
  .overlay-fog{ background: radial-gradient(700px 520px at 22% 18%, rgba(226,232,240,.10), transparent 64%); }
  .overlay-windy{ background: radial-gradient(700px 520px at 22% 18%, rgba(165,180,252,.12), transparent 64%); }
  .overlay-night{ background: radial-gradient(800px 560px at 22% 18%, rgba(167,139,250,.10), transparent 64%); }

  .rain::before{ content:""; position:absolute; inset:-40px; background: repeating-linear-gradient(115deg, rgba(255,255,255,.06) 0 2px, transparent 2px 12px); transform: translateY(-20px); animation: rainFall 1.1s linear infinite; opacity:.5; }
  @keyframes rainFall { to { transform: translateY(40px); } }
  .snow::before{ content:""; position:absolute; inset:0; background-image: radial-gradient(rgba(255,255,255,.35) 1px, transparent 1px); background-size: 22px 22px; animation: snowDrift 9s linear infinite; opacity:.25; }
  @keyframes snowDrift { to { background-position: 0 240px; } }
  .stars::before{ content:""; position:absolute; inset:0; background-image: radial-gradient(rgba(255,255,255,.55) 1px, transparent 1px); background-size: 26px 26px; opacity:.14; }

  .top{ display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }
  .temp{ font-size:72px; font-weight:950; letter-spacing:-1px; line-height:1; }
  .meta{ margin-top:6px; opacity:.88; font-size:13px; font-weight:800; }
  .clockLine{ margin-top:8px; display:flex; gap:10px; align-items:baseline; font-weight:900; }
  .clock{ font-size:28px; font-weight:950; letter-spacing:.8px; opacity:.96; text-shadow:0 12px 28px rgba(0,0,0,.40); }
  .date{ font-size:14px; font-weight:800; opacity:.82; }

  .icon{ width:74px; height:74px; color:#fff; filter: drop-shadow(0 16px 26px rgba(0,0,0,.35)); animation: floaty 6.5s cubic-bezier(.4,0,.2,1) infinite; }
  @keyframes floaty{ 0%,100%{ transform: translate3d(0,0,0) scale(1);} 50%{ transform: translate3d(0,-9px,0) scale(1.02);} }

  .wscSvg.sun .sunRays{ transform-origin: 32px 32px; animation: spin 10s linear infinite; }
  @keyframes spin{ to{ transform: rotate(360deg);} }
  .wscSvg.rain .drops path{ animation: drop 1.25s ease-in-out infinite; }
  .wscSvg.rain .drops path:nth-child(2){ animation-delay:.15s; }
  .wscSvg.rain .drops path:nth-child(3){ animation-delay:.3s; }
  @keyframes drop{ 0%{ opacity:.25; transform: translateY(-3px);} 50%{opacity:1; transform: translateY(2px);} 100%{opacity:.25; transform: translateY(-3px);} }
  .wscSvg.thunder .bolt{ animation: flash 2.4s ease-in-out infinite; transform-origin: 32px 44px; }
  @keyframes flash{ 0%,65%,100%{opacity:.45; transform:scale(1);} 70%{opacity:1; transform:scale(1.05);} 80%{opacity:.55;} }
  .wscSvg.wind .windLines{ animation: wind 2.8s ease-in-out infinite; }
  @keyframes wind{ 0%,100%{ transform: translateX(0); opacity:.85;} 50%{ transform: translateX(6px); opacity:1;} }
  .wscSvg.fog .fogLines{ animation: fog 4.2s ease-in-out infinite; }
  @keyframes fog{ 0%,100%{ transform: translateX(0); opacity:.65;} 50%{ transform: translateX(6px); opacity:.95;} }
  .wscSvg.snow .flakes{ animation: snow 2.9s ease-in-out infinite; }
  @keyframes snow{ 0%,100%{ transform: translateY(0); opacity:.75;} 50%{ transform: translateY(4px); opacity:1;} }

  .badges{ margin-top:12px; display:flex; flex-wrap:nowrap; gap:8px; overflow-x:auto; -webkit-overflow-scrolling: touch; scrollbar-width:none; }
  .badges::-webkit-scrollbar{ display:none; }
  .badge{ white-space:nowrap; background: rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.10); padding:6px 12px; border-radius:999px; font-size:12px; font-weight:800; backdrop-filter: blur(12px); }

  .actions{ margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .btn{ border:1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color:#fff; padding:10px 12px; border-radius:14px; font-weight:950; cursor:pointer; user-select:none; backdrop-filter: blur(12px); display:inline-flex; align-items:center; gap:10px; }
  .btnIco{ width:18px; height:18px; }
  .btn.on{ background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.26); }
  .btnLabel{ font-size:12px; opacity:.9; }

  .sectionTitle{ margin-top:14px; font-size:12px; letter-spacing:.4px; text-transform:uppercase; opacity:.72; font-weight:900; }
  .forecastRow{ margin-top:10px; display:flex; gap:10px; overflow-x:auto; -webkit-overflow-scrolling:touch; scrollbar-width:none; }
  .forecastRow::-webkit-scrollbar{ display:none; }
  .fcDay, .fcHour{ min-width:74px; background: rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.08); border-radius:18px; padding:10px; backdrop-filter: blur(14px); text-align:center; }
  .fcD,.fcH{ font-size:12px; font-weight:900; opacity:.85; }
  .fcI{ margin-top:6px; display:flex; justify-content:center; }
  .fcI svg{ width:28px; height:28px; }
  .fcI.small svg{ width:24px; height:24px; }
  .fcT{ margin-top:6px; font-size:14px; font-weight:950; }
  .fcLo{ margin-left:6px; font-weight:900; opacity:.65; }

  .grid{ margin-top:14px; display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; }
  .tile{ background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.08); border-radius:18px; padding:14px; backdrop-filter: blur(14px); }
  .k{ font-size:12px; opacity:.72; font-weight:800; }
  .v{ margin-top:6px; font-size:18px; font-weight:950; }
  .dirWrap{ display:flex; align-items:center; gap:10px; justify-content:center; }
  .dir{ display:inline-block; font-size:22px; filter: drop-shadow(0 8px 14px rgba(0,0,0,.35)); transition: transform .6s ease; }
  .dirDeg{ font-size:12px; opacity:.75; font-weight:800; }

  .chartWrap{ margin-top:14px; background: rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.08); border-radius:18px; padding:12px; backdrop-filter: blur(14px); }
  .chartTop{ display:flex; justify-content:space-between; align-items:baseline; gap:10px; margin-bottom:10px; }
  .chartTitle{ font-size:12px; font-weight:950; opacity:.88; }
  .chartMeta{ font-size:12px; font-weight:900; opacity:.65; }
  canvas.spark{ width:100%; height:140px; display:block; touch-action: pan-x; }
  .dots{ margin-top:8px; display:flex; justify-content:center; gap:6px; }
  .dot{ width:6px; height:6px; border-radius:999px; background: rgba(255,255,255,.22); }
  .dot.on{ background: rgba(255,255,255,.70); }
  .chartNav{ margin-top:10px; display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .navBtn{ width:34px; height:34px; border-radius:12px; border:1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color:#fff; display:grid; place-items:center; cursor:pointer; }
  .navHint{ flex:1; font-size:11px; opacity:.62; text-align:center; font-weight:800; user-select:none; }

  .footer{ margin-top:12px; display:flex; justify-content:space-between; font-size:11px; opacity:.6; font-weight:800; }

  ha-card > *{ position:relative; z-index:2; }
  .overlay,.rain,.snow,.stars{ z-index:1; }

  @media (max-width: 420px) {
    ha-card { padding: 18px; border-radius: 24px; }
    .temp { font-size: 56px; }
    .icon { width:60px; height:60px; }
    .clock { font-size: 22px; }
    canvas.spark{ height:132px; }
  }
</style>

<ha-card>
  ${overlays}

  <div class="top">
    <div>
      <div class="temp">${temp == null ? "—" : temp.toFixed(1)}°</div>

      ${showName ? `<div class="meta">${this._esc(this._config.nome)}</div>` : ""}

      ${(showClock || showDate) ? `
        <div class="clockLine">
          ${showClock ? `<div class="clock">${now.time}</div>` : ""}
          ${showDate ? `<div class="date">${now.date}</div>` : ""}
        </div>` : ""}

      <div class="badges">${badgesHTML}</div>
    </div>

    <div class="icon">${this._iconSVG(cond.iconKey)}</div>
  </div>

  ${dailyHTML}
  ${hourlyHTML}

  ${stationMode ? `
    <div class="actions">
      <button class="btn ${this._ui.showCharts ? "on" : ""}" id="wscBtnCharts">${this._btnIcon("charts")} <span class="btnLabel">Grafici</span></button>
      <button class="btn ${this._ui.showDetails ? "on" : ""}" id="wscBtnDetails">${this._btnIcon("details")} <span class="btnLabel">Dati</span></button>
    </div>

    ${chartHTML}

    ${this._ui.showDetails ? `
      <div class="grid">${detailsTiles}</div>
      ${internalTiles.trim() ? `<div class="grid">${internalTiles}</div>` : ""}
      ${storiciTiles.trim() ? `<div class="grid">${storiciTiles}</div>` : ""}
    ` : ""}
  ` : ""}

  <div class="footer">
    <div>WSC PRO</div>
    <div>v${WSCCard.VERSION}</div>
  </div>
</ha-card>
      `;

      // Bind buttons if station mode
      if (stationMode) {
        const bC = this.shadowRoot.querySelector("#wscBtnCharts");
        const bD = this.shadowRoot.querySelector("#wscBtnDetails");
        if (bC) bC.onclick = this._onToggleCharts;
        if (bD) bD.onclick = this._onToggleDetails;

        const prev = this.shadowRoot.querySelector("#wscPrev");
        const next = this.shadowRoot.querySelector("#wscNext");
        if (prev) prev.onclick = this._onPrevChart;
        if (next) next.onclick = this._onNextChart;

        if (this._ui.showCharts && active) {
          const canvas = this.shadowRoot.querySelector("#wsc_chart_canvas");
          if (canvas) {
            this._bindChartInteractions(canvas, active.key, active.unit || "");
            this._scheduleDrawChart(canvas, active.key, active.unit || "");
          }
        }
      }
    }
  }

  class WSCEditor extends HTMLElement {
    setConfig(config) { this._config = config || {}; this._render(); }
    set hass(hass) { this._hass = hass; }
    _render() {
      const schema = [
        { name: "weather_entity", required: true, selector: { entity: { domain: "weather" } } },
        { type: "grid", name: "", schema: [
          { name: "nome", selector: { text: {} } },
          { name: "mostra_nome", selector: { boolean: {} } },
          { name: "mostra_orologio", selector: { boolean: {} } },
          { name: "mostra_data", selector: { boolean: {} } },
        ]},
        { name: "forecast_days", selector: { number: { min: 0, max: 7, mode: "box" } } },
        { name: "forecast_hours", selector: { number: { min: 0, max: 48, mode: "box" } } },
        { type: "expandable", title: "Sensori stazione meteo (opzionali)", schema: [
          { name: "temperatura", selector: { entity: { domain: "sensor" } } },
          { name: "umidita", selector: { entity: { domain: "sensor" } } },
          { name: "velocita_vento", selector: { entity: { domain: "sensor" } } },
          { name: "raffica_vento", selector: { entity: { domain: "sensor" } } },
          { name: "direzione_vento", selector: { entity: { domain: "sensor" } } },
          { name: "tasso_pioggia", selector: { entity: { domain: "sensor" } } },
          { name: "pressione_relativa", selector: { entity: { domain: "sensor" } } },
          { name: "pressione_assoluta", selector: { entity: { domain: "sensor" } } },
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
        ]},
        { type: "expandable", title: "Grafici (opzionali)", schema: [
          { name: "sample_interval_sec", selector: { number: { min: 15, max: 900, mode: "box" } } },
          { name: "history_hours", selector: { number: { min: 1, max: 72, mode: "box" } } },
          { name: "smoothing", selector: { number: { min: 0, max: 0.5, step: 0.01, mode: "box" } } },
        ]},
      ];

      this.innerHTML = `
        <div style="padding:0 4px 10px 4px">
          <ha-form
            .hass=${this._hass}
            .data=${this._config}
            .schema=${schema}
            .computeLabel=${(s) => {
              const labels = {
                weather_entity: "Entità meteo (obbligatoria)",
                nome: "Nome",
                mostra_nome: "Mostra nome",
                mostra_orologio: "Mostra orologio",
                mostra_data: "Mostra data",
                forecast_days: "Giorni previsione",
                forecast_hours: "Ore previsione",
                temperatura: "Sensore temperatura",
                umidita: "Sensore umidità",
                velocita_vento: "Sensore vento",
                raffica_vento: "Sensore raffica vento",
                direzione_vento: "Sensore direzione vento",
                tasso_pioggia: "Sensore pioggia (mm/h)",
                pressione_relativa: "Sensore pressione relativa",
                pressione_assoluta: "Sensore pressione assoluta",
                uv: "Sensore UV",
                lux: "Sensore Lux",
                radiazione_solare: "Sensore radiazione solare",
                punto_rugiada: "Sensore punto di rugiada",
                vpd: "Sensore VPD",
                temperatura_interna: "Sensore temperatura interna",
                umidita_interna: "Sensore umidità interna",
                pioggia_giornaliera: "Pioggia oggi",
                pioggia_settimanale: "Pioggia settimanale",
                pioggia_mensile: "Pioggia mensile",
                pioggia_annuale: "Pioggia annuale",
                sample_interval_sec: "Intervallo campionamento (s)",
                history_hours: "Storico (ore)",
                smoothing: "Smussamento grafici (0..0.5)",
              };
              return labels[s.name] ?? s.name;
            }}
          ></ha-form>
        </div>
      `;

      const form = this.querySelector("ha-form");
      form?.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: ev.detail.value },
          bubbles: true,
          composed: true,
        }));
      });
    }
  }

  if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, WSCCard);
  if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, WSCEditor);
})();
