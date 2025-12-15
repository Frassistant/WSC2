/* WSC PRO – Weather Station Card
 * v1.7.2
 * - Dual mode: PRO (station sensors) or SIMPLE (weather entity)
 * - Aliases: name/nome ; temperature/temperatura
 * - Two toggles: Grafici / Dati & Storici
 * - Realtime rain: tasso_pioggia + pioggia_evento (delta ultimi minuti)
 * - Adaptive tiles (missing entity -> hidden)
 * - Smooth icon animation
 * - Stable charts (no scroll jump)
 */

class WSCCard extends HTMLElement {
  static VERSION = "1.0.3";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = { showCharts: false, showDetails: false };
    this._series = new Map(); // key -> [{t,v}]
    this._raf = null;
    this._pending = false;

    this._lastRainEvent = null;
    this._lastRainTs = 0;

    this._onToggleCharts = () => {
      this._ui.showCharts = !this._ui.showCharts;
      this._scheduleRender(true);
    };
    this._onToggleDetails = () => {
      this._ui.showDetails = !this._ui.showDetails;
      this._scheduleRender(true);
    };
  }

  setConfig(cfg) {
    if (!cfg) throw new Error("Config mancante");

    // alias support
    const nome = cfg.nome ?? cfg.name ?? "";
    const temperatura = cfg.temperatura ?? cfg.temperature ?? null;

    const weather_entity = cfg.weather_entity ?? cfg.weather ?? null;

    if (!temperatura && !weather_entity) {
      throw new Error('Devi specificare "temperatura" (stazione) oppure "weather_entity" (meteo semplice)');
    }

    this._config = {
      nome,
      mostra_nome: cfg.mostra_nome ?? true,
      mostra_orologio: cfg.mostra_orologio ?? true,
      mostra_data: cfg.mostra_data ?? true,

      // default toggles state (optional)
      mostra_grafici_default: cfg.mostra_grafici_default ?? false,
      mostra_storici_default: cfg.mostra_storici_default ?? false,

      // weather entity (simple mode)
      weather_entity,

      // station sensors (pro mode)
      temperatura,
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

      temperatura_interna: cfg.temperatura_interna ?? null,
      umidita_interna: cfg.umidita_interna ?? null,
      punto_rugiada_interno: cfg.punto_rugiada_interno ?? null,

      pioggia_oraria: cfg.pioggia_oraria ?? null,
      pioggia_giornaliera: cfg.pioggia_giornaliera ?? null,
      pioggia_settimanale: cfg.pioggia_settimanale ?? null,
      pioggia_mensile: cfg.pioggia_mensile ?? null,
      pioggia_annuale: cfg.pioggia_annuale ?? null,
      raffica_massima_giornaliera: cfg.raffica_massima_giornaliera ?? null,

      mostra_badge_pioggia_se_non_piove: cfg.mostra_badge_pioggia_se_non_piove ?? false,
    };

    this._ui.showCharts = !!this._config.mostra_grafici_default;
    this._ui.showDetails = !!this._config.mostra_storici_default;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._scheduleRender();
  }

  getCardSize() {
    // prevent huge jumps
    return this._ui.showCharts || this._ui.showDetails ? 16 : 10;
  }

  /* -------------------- utils -------------------- */

  _state(e) {
    if (!e) return null;
    const s = this._hass?.states?.[e];
    if (!s) return null;
    if (s.state === "unavailable" || s.state === "unknown" || s.state === "" || s.state == null) return null;
    return s;
  }

  _num(e) {
    const s = this._state(e);
    if (!s) return null;
    const n = Number(s.state);
    return Number.isFinite(n) ? n : null;
  }

  _unit(e, fallback = "") {
    const s = this._state(e);
    return s?.attributes?.unit_of_measurement ?? fallback;
  }

  _fmtEntity(e, digits = 1, suffix = null) {
    const n = this._num(e);
    if (n === null) return null;
    const u = suffix !== null ? suffix : this._unit(e, "");
    const v = n.toFixed(digits);
    return u ? `${v} ${u}` : v;
  }

  _fmtNum(n, digits = 1, suffix = "") {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    const v = n.toFixed(digits);
    return suffix ? `${v} ${suffix}` : v;
  }

  _esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  _now() {
    const d = new Date();
    return {
      time: d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      date: d.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short" }),
    };
  }

  _isSimpleMode() {
    return !!this._config.weather_entity && !this._config.temperatura;
  }

  /* -------------------- rain realtime -------------------- */

  _updateRainEvent() {
    const e = this._num(this._config.pioggia_evento);
    if (e === null) return;

    if (this._lastRainEvent === null) {
      this._lastRainEvent = e;
      return;
    }
    if (e > this._lastRainEvent) this._lastRainTs = Date.now();
    this._lastRainEvent = e;
  }

  _isRainingNow() {
    this._updateRainEvent();
    const rate = this._num(this._config.tasso_pioggia) ?? 0;
    if (rate > 0.1) return true;
    // se evento è aumentato negli ultimi 5 min
    return (Date.now() - this._lastRainTs) < 5 * 60 * 1000;
  }

  /* -------------------- condition / theme -------------------- */

  _computeConditionPRO() {
    const rain = this._isRainingNow();

    const uv = this._num(this._config.uv) ?? 0;
    const lux = this._num(this._config.lux) ?? 0;
    const solar = this._num(this._config.radiazione_solare) ?? 0;

    const hum = this._num(this._config.umidita);
    const wind = this._num(this._config.velocita_vento) ?? 0;

    // Sole: basta luce alta o UV > 0 o radiazione sensata
    const sunnyStrong = !rain && (uv >= 1 || solar >= 140 || lux >= 6500);
    // Parz. nuvoloso: luce presente ma non “forte” + umidità / variabilità
    const sunnySoft = !rain && !sunnyStrong && (solar >= 70 || lux >= 3500 || uv >= 0.5);

    const fog = !rain && hum !== null && hum >= 92 && solar < 60 && wind < 3;

    if (rain) return { k: "pioggia", l: "Pioggia", i: "🌧️" };
    if (fog) return { k: "nebbia", l: "Nebbia", i: "🌫️" };
    if (sunnyStrong) return { k: "sole", l: "Sole", i: "☀️" };
    if (sunnySoft) return { k: "parzialmente", l: "Parz. nuvoloso", i: "⛅" };
    if (wind >= 25) return { k: "vento", l: "Ventoso", i: "🌬️" };
    return { k: "coperto", l: "Coperto", i: "☁️" };
  }

  _computeConditionSIMPLE() {
    const s = this._state(this._config.weather_entity);
    const st = (s?.state ?? "").toLowerCase();

    const map = {
      "clear-night": { k:"sole", l:"Sereno", i:"🌙" },
      "sunny": { k:"sole", l:"Sole", i:"☀️" },
      "clear": { k:"sole", l:"Sole", i:"☀️" },
      "partlycloudy": { k:"parzialmente", l:"Parz. nuvoloso", i:"⛅" },
      "cloudy": { k:"coperto", l:"Coperto", i:"☁️" },
      "rainy": { k:"pioggia", l:"Pioggia", i:"🌧️" },
      "pouring": { k:"pioggia", l:"Pioggia forte", i:"🌧️" },
      "snowy": { k:"neve", l:"Neve", i:"❄️" },
      "fog": { k:"nebbia", l:"Nebbia", i:"🌫️" },
      "windy": { k:"vento", l:"Ventoso", i:"🌬️" },
    };

    return map[st] ?? { k:"coperto", l: s?.state ?? "Meteo", i:"☁️" };
  }

  _theme(k) {
    const t = {
      sole:        { a:"#0b1220", b:"#102a43", glow:"rgba(255,214,102,.45)" },
      parzialmente:{ a:"#0b1220", b:"#1e293b", glow:"rgba(253,224,71,.25)" },
      coperto:     { a:"#0b1220", b:"#0f172a", glow:"rgba(148,163,184,.22)" },
      pioggia:     { a:"#071325", b:"#0b2a4a", glow:"rgba(56,189,248,.35)" },
      nebbia:      { a:"#0b1220", b:"#111827", glow:"rgba(226,232,240,.20)" },
      vento:       { a:"#0b1220", b:"#0d1b3f", glow:"rgba(165,180,252,.25)" },
      neve:        { a:"#0b1220", b:"#0f172a", glow:"rgba(240,249,255,.25)" },
    };
    return t[k] ?? t.coperto;
  }

  /* -------------------- charts -------------------- */

  _pushSeries(key, v) {
    if (!Number.isFinite(v)) return;
    const now = Date.now();
    const arr = this._series.get(key) ?? [];
    arr.push({ t: now, v });

    const maxAge = 60 * 60 * 1000; // 1h
    while (arr.length && now - arr[0].t > maxAge) arr.shift();
    while (arr.length > 180) arr.shift();

    this._series.set(key, arr);
  }

  _samplePRO() {
    const temp = this._num(this._config.temperatura);
    const wind = this._num(this._config.velocita_vento);
    const rain = this._num(this._config.tasso_pioggia);
    const solar = this._num(this._config.radiazione_solare);
    const press = this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta);

    if (temp !== null) this._pushSeries("temp", temp);
    if (wind !== null) this._pushSeries("wind", wind);
    if (rain !== null) this._pushSeries("rain", rain);
    if (solar !== null) this._pushSeries("solar", solar);
    if (press !== null) this._pushSeries("press", press);
  }

  _spark(canvas, key) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const data = this._series.get(key) ?? [];
    const w = canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio);
    const h = canvas.height = Math.max(1, canvas.clientHeight * devicePixelRatio);

    ctx.clearRect(0, 0, w, h);
    if (data.length < 2) return;

    const vals = data.map(p => p.v);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = (max - min) || 1;

    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(0, h - 2);
    ctx.lineTo(w, h - 2);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((data[i].v - min) / span) * (h * 0.90) - (h * 0.05);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  _renderCharts() {
    if (!this.shadowRoot) return;
    const canvases = this.shadowRoot.querySelectorAll("canvas.spark");
    canvases.forEach(c => this._spark(c, c.getAttribute("data-series")));
  }

  /* -------------------- ui blocks -------------------- */

  _badge(html) {
    return `<div class="badge">${html}</div>`;
  }

  _tile(title, value, hint = "") {
    if (value === null || value === undefined || value === "") return "";
    return `
      <div class="tile" title="${this._esc(hint)}">
        <div class="tileT">${this._esc(title)}</div>
        <div class="tileV">${value}</div>
      </div>
    `;
  }

  _scheduleRender(force = false) {
    if (this._pending && !force) return;
    this._pending = true;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      this._pending = false;
      if (!this._isSimpleMode()) this._samplePRO();
      this._render();
    });
  }

  /* -------------------- render -------------------- */

  _render() {
    if (!this._hass || !this._config) return;

    const simple = this._isSimpleMode();
    const cond = simple ? this._computeConditionSIMPLE() : this._computeConditionPRO();
    const theme = this._theme(cond.k);
    const now = this._now();

    // top temperature
    let tempTop = "—";
    if (simple) {
      const w = this._state(this._config.weather_entity);
      const t = w?.attributes?.temperature;
      if (typeof t === "number") tempTop = t.toFixed(1);
      else if (t != null && t !== "") tempTop = Number(t).toFixed(1);
    } else {
      const t = this._num(this._config.temperatura);
      tempTop = t === null ? "—" : t.toFixed(1);
    }

    // badges PRO
    const hum = this._num(this._config.umidita);
    const wind = this._num(this._config.velocita_vento);
    const rainRate = this._num(this._config.tasso_pioggia);
    const showRainBadge = this._isRainingNow() || this._config.mostra_badge_pioggia_se_non_piove;

    // tiles PRO (now)
    const gust = this._num(this._config.raffica_vento);
    const wdir = this._num(this._config.direzione_vento);
    const uv = this._num(this._config.uv);
    const solar = this._num(this._config.radiazione_solare);
    const lux = this._num(this._config.lux);
    const dew = this._num(this._config.punto_rugiada);
    const vpd = this._num(this._config.vpd);
    const press = this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta);

    const windArrow = (wdir === null) ? null : `
      <span class="dirWrap">
        <span class="dir" style="transform:rotate(${wdir}deg)">➤</span>
        <span class="dirDeg">${Math.round(wdir)}°</span>
      </span>
    `;

    // details
    const indoorT = this._fmtEntity(this._config.temperatura_interna, 1);
    const indoorH = this._fmtEntity(this._config.umidita_interna, 0);
    const dewIn = this._fmtEntity(this._config.punto_rugiada_interno, 1);

    const absP = this._fmtEntity(this._config.pressione_assoluta, 1);
    const relP = this._fmtEntity(this._config.pressione_relativa, 1);

    const rainH = this._fmtEntity(this._config.pioggia_oraria, 1);
    const rainD = this._fmtEntity(this._config.pioggia_giornaliera, 1);
    const rainW = this._fmtEntity(this._config.pioggia_settimanale, 1);
    const rainM = this._fmtEntity(this._config.pioggia_mensile, 1);
    const rainY = this._fmtEntity(this._config.pioggia_annuale, 1);

    const gustMax = this._fmtEntity(this._config.raffica_massima_giornaliera, 1);

    const showRainAnim = !simple && cond.k === "pioggia";
    const showSunGlow = !simple && (cond.k === "sole" || cond.k === "parzialmente");
    const showWindAnim = !simple && cond.k === "vento";

    const glowOpacity = Math.min(1, Math.max(.20, ((solar ?? 120) / 600)));

    const chartsHTML = (!simple && this._ui.showCharts) ? `
      <div class="section">
        <div class="secT">Grafici realtime (1h)</div>
        <div class="charts">
          ${this._num(this._config.temperatura) !== null ? `<div class="chart"><div class="cHead">Temperatura</div><canvas class="spark" data-series="temp"></canvas></div>` : ""}
          ${this._num(this._config.velocita_vento) !== null ? `<div class="chart"><div class="cHead">Vento</div><canvas class="spark" data-series="wind"></canvas></div>` : ""}
          ${this._num(this._config.tasso_pioggia) !== null ? `<div class="chart"><div class="cHead">Pioggia</div><canvas class="spark" data-series="rain"></canvas></div>` : ""}
          ${this._num(this._config.radiazione_solare) !== null ? `<div class="chart"><div class="cHead">Radiazione</div><canvas class="spark" data-series="solar"></canvas></div>` : ""}
          ${((this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta)) !== null) ? `<div class="chart"><div class="cHead">Pressione</div><canvas class="spark" data-series="press"></canvas></div>` : ""}
        </div>
      </div>
    ` : "";

    const detailsHTML = (!simple && this._ui.showDetails) ? `
      <div class="section">
        <div class="secT">Dati & storici</div>
        <div class="grid">
          ${this._tile("Temperatura interna", indoorT, "Temperatura rilevata indoor")}
          ${this._tile("Umidità interna", indoorH, "Umidità rilevata indoor")}
          ${this._tile("P. rugiada interno", dewIn, "Punto di rugiada indoor")}

          ${this._tile("Pressione assoluta", absP, "Pressione assoluta")}
          ${this._tile("Pressione relativa", relP, "Pressione relativa")}

          ${this._tile("Pioggia 1h", rainH, "Accumulo ultima ora")}
          ${this._tile("Pioggia oggi", rainD, "Accumulo giornaliero")}
          ${this._tile("Pioggia sett.", rainW, "Accumulo settimanale")}
          ${this._tile("Pioggia mese", rainM, "Accumulo mensile")}
          ${this._tile("Pioggia anno", rainY, "Accumulo annuale")}

          ${this._tile("Raffica max oggi", gustMax, "Raffica massima giornaliera")}
        </div>
      </div>
    ` : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host{ display:block; }
        ha-card{
          position:relative;
          overflow:hidden;
          padding:26px;
          border-radius:32px;
          color:#fff;
          background:
            radial-gradient(820px 520px at 16% 12%, ${theme.glow}, transparent 60%),
            linear-gradient(135deg, ${theme.a}, ${theme.b});
          box-shadow: 0 40px 90px rgba(0,0,0,.45);
        }
        .glass{
          position:absolute; inset:0;
          background: radial-gradient(900px 520px at 70% 10%, rgba(255,255,255,.10), transparent 60%);
          pointer-events:none;
        }

        .top{ display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
        .temp{
          font-size:78px; font-weight:900; letter-spacing:-1px; line-height:1;
          text-shadow: 0 18px 40px rgba(0,0,0,.35);
        }

        .meta{ margin-top:8px; opacity:.85; font-size:13px; }
        .name{ margin-top:6px; opacity:.90; font-size:13px; }

        /* BADGES: single line */
        .badges{
          margin-top:10px;
          display:flex;
          gap:8px;
          flex-wrap:nowrap;
          overflow-x:auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
        }
        .badges::-webkit-scrollbar{ display:none; }
        .badge{
          white-space:nowrap;
          display:flex; gap:8px; align-items:center;
          padding:7px 12px;
          border-radius:999px;
          background: rgba(255,255,255,.14);
          border: 1px solid rgba(255,255,255,.12);
          backdrop-filter: blur(14px);
          font-size:12px;
          flex: 0 0 auto;
        }

        /* icon: smoother */
        .icon{
          font-size:78px;
          filter: drop-shadow(0 18px 30px rgba(0,0,0,.35));
          animation: floaty 7s cubic-bezier(.4,0,.2,1) infinite;
          will-change: transform;
        }
        @keyframes floaty{
          0%{ transform: translate3d(0,0,0) rotate(0deg) scale(1); }
          50%{ transform: translate3d(0,-10px,0) rotate(1.5deg) scale(1.02); }
          100%{ transform: translate3d(0,0,0) rotate(0deg) scale(1); }
        }

        .grid{
          margin-top:18px;
          display:grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap:14px;
        }
        .tile{
          background: rgba(255,255,255,.12);
          border: 1px solid rgba(255,255,255,.10);
          border-radius:18px;
          padding:14px;
          backdrop-filter: blur(14px);
        }
        .tileT{ font-size:12px; opacity:.75; margin-bottom:8px; }
        .tileV{ font-size:18px; font-weight:900; }

        .dirWrap{ display:flex; align-items:center; gap:10px; justify-content:center; }
        .dir{ display:inline-block; font-size:24px; transition: transform .6s ease; }
        .dirDeg{ font-size:12px; opacity:.75; }

        .actions{
          margin-top:14px;
          display:flex;
          gap:10px;
          flex-wrap:wrap;
        }
        .btn{
          border: 1px solid rgba(255,255,255,.18);
          background: rgba(255,255,255,.10);
          color:#fff;
          padding:10px 14px;
          border-radius:14px;
          font-weight:900;
          cursor:pointer;
        }
        .btn:hover{ background: rgba(255,255,255,.16); }
        .btn.on{ background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.30); }

        .footer{
          margin-top:12px;
          display:flex;
          justify-content:space-between;
          font-size:11px;
          opacity:.6;
        }

        .section{ margin-top:16px; }
        .secT{ font-size:12px; opacity:.75; margin-bottom:10px; }

        .charts{
          display:grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px;
        }
        .chart{
          background: rgba(255,255,255,.10);
          border: 1px solid rgba(255,255,255,.10);
          border-radius:18px;
          padding:12px;
          backdrop-filter: blur(14px);
        }
        .cHead{ font-size:12px; opacity:.75; margin-bottom:10px; }
        canvas.spark{ width:100%; height:72px; display:block; }

        /* overlays */
        .sunGlow{
          position:absolute; inset:-40% -30%;
          background: radial-gradient(circle at 18% 18%, rgba(255,214,102,.55), transparent 55%);
          pointer-events:none;
          mix-blend-mode: screen;
          opacity:${glowOpacity};
          animation: sunPulse 4.2s ease-in-out infinite;
        }
        @keyframes sunPulse{ 0%,100%{ transform:scale(1);} 50%{ transform:scale(1.04);} }

        .rain{ position:absolute; inset:0; pointer-events:none; overflow:hidden; opacity:.95; }
        .rain i{
          position:absolute; top:-20%;
          width:2px; height:28px;
          background: rgba(255,255,255,.45);
          border-radius:999px;
          animation: drop 1.05s linear infinite;
        }
        @keyframes drop{ to{ transform: translateY(150vh); } }

        .wind{ position:absolute; inset:0; pointer-events:none; opacity:.65; }
        .wind span{
          position:absolute; left:-30%;
          height:2px; width:55%;
          background: rgba(255,255,255,.26);
          border-radius:999px;
          animation: gust 2.2s linear infinite;
        }
        @keyframes gust{ to{ transform: translateX(180%); } }
      </style>

      <ha-card>
        ${showSunGlow ? `<div class="sunGlow"></div>` : ""}
        ${showRainAnim ? `<div class="rain">${Array.from({length:18}).map(()=>`<i></i>`).join("")}</div>` : ""}
        ${showWindAnim ? `<div class="wind">${Array.from({length:9}).map(()=>`<span></span>`).join("")}</div>` : ""}
        <div class="glass"></div>

        <div class="top">
          <div>
            <div class="temp">${tempTop}°</div>

            ${(this._config.mostra_orologio || this._config.mostra_data)
              ? `<div class="meta">
                    ${this._config.mostra_orologio ? now.time : ""}
                    ${this._config.mostra_data ? " • " + now.date : ""}
                 </div>`
              : ""}

            ${(this._config.mostra_nome && this._config.nome)
              ? `<div class="name">${this._esc(this._config.nome)}</div>`
              : ""}

            <div class="badges">
              ${this._badge(`${cond.i} <b>${this._esc(cond.l)}</b>`)}
              ${(!simple && hum !== null) ? this._badge(`💧 <b>${Math.round(hum)}%</b>`) : ""}
              ${(!simple && wind !== null) ? this._badge(`🌬️ <b>${wind.toFixed(1)} km/h</b>`) : ""}
              ${(!simple && showRainBadge && rainRate !== null) ? this._badge(`🌧️ <b>${rainRate.toFixed(1)} mm/h</b>`) : ""}
              ${(simple) ? (() => {
                const w = this._state(this._config.weather_entity);
                const a = w?.attributes ?? {};
                const humW = (typeof a.humidity === "number") ? a.humidity : null;
                const windW = (typeof a.wind_speed === "number") ? a.wind_speed : null;
                return `
                  ${humW !== null ? this._badge(`💧 <b>${humW}%</b>`) : ""}
                  ${windW !== null ? this._badge(`🌬️ <b>${windW} km/h</b>`) : ""}
                `;
              })() : ""}
            </div>
          </div>

          <div class="icon">${cond.i}</div>
        </div>

        ${simple ? "" : `
          <div class="grid">
            ${this._tile("Velocità vento", wind === null ? null : `${wind.toFixed(1)} km/h`, "Velocità vento istantanea")}
            ${this._tile("Raffica vento", gust === null ? null : `${gust.toFixed(1)} km/h`, "Raffica attuale")}
            ${this._tile("Direzione vento", windArrow, "Direzione vento (gradi)")}

            ${this._tile("Umidità esterna", hum === null ? null : `${Math.round(hum)}%`, "Umidità esterna")}
            ${this._tile("Punto di rugiada", dew === null ? null : `${dew.toFixed(1)}°`, "Temperatura di condensa")}
            ${this._tile("VPD", vpd === null ? null : `${vpd.toFixed(2)} hPa`, "Deficit pressione di vapore")}

            ${this._tile("Tasso pioggia", rainRate === null ? null : `${rainRate.toFixed(1)} mm/h`, "Pioggia realtime (mm/h)")}
            ${this._tile("UV", uv === null ? null : `${Math.round(uv)}`, "Indice UV")}
            ${this._tile("Radiazione solare", solar === null ? null : `${solar.toFixed(0)} W/m²`, "Energia solare")}
            ${this._tile("Luce (Lux)", lux === null ? null : `${lux.toFixed(0)}`, "Luminosità")}
            ${this._tile("Pressione", press === null ? null : `${press.toFixed(1)} hPa`, "Pressione")}
          </div>

          <div class="actions">
            <button class="btn ${this._ui.showCharts ? "on" : ""}" id="btnCharts">Mostra grafici</button>
            <button class="btn ${this._ui.showDetails ? "on" : ""}" id="btnDetails">Mostra dati & storici</button>
          </div>

          ${chartsHTML}
          ${detailsHTML}
        `}

        <div class="footer">
          <div>WSC PRO</div>
          <div>v${WSCCard.VERSION}</div>
        </div>
      </ha-card>
    `;

    // overlays tuning
    if (showRainAnim) {
      const drops = this.shadowRoot.querySelectorAll(".rain i");
      drops.forEach((el, idx) => {
        el.style.left = `${(idx * 5.5) % 100}%`;
        el.style.animationDelay = `${(idx * 0.07).toFixed(2)}s`;
        el.style.animationDuration = `${(0.85 + (idx % 5) * 0.08).toFixed(2)}s`;
        el.style.opacity = `${(0.35 + (idx % 6) * 0.10).toFixed(2)}`;
      });
    }
    if (showWindAnim) {
      const lines = this.shadowRoot.querySelectorAll(".wind span");
      lines.forEach((el, idx) => {
        el.style.top = `${10 + idx * 9}%`;
        el.style.animationDelay = `${(idx * 0.18).toFixed(2)}s`;
        el.style.animationDuration = `${(1.8 + (idx % 4) * 0.35).toFixed(2)}s`;
        el.style.opacity = `${(0.25 + (idx % 5) * 0.12).toFixed(2)}`;
      });
    }

    // bind buttons
    const bC = this.shadowRoot.querySelector("#btnCharts");
    if (bC) bC.onclick = this._onToggleCharts;
    const bD = this.shadowRoot.querySelector("#btnDetails");
    if (bD) bD.onclick = this._onToggleDetails;

    // render charts after DOM
    this._renderCharts();
  }
}

customElements.define("weather-station-card2", WSCCard);

// Optional: HA card picker description
window.customCards = window.customCards || [];
window.customCards.push({
  type: "weather-station-card",
  name: "WSC PRO – Weather Station Card",
  description: "Card meteo futuristica: modalità stazione meteo o meteo semplice (weather.*).",
});
