/* WSC PRO – Weather Station Card
 * v1.7.0 (upgrade)
 * - Time/date più leggibili
 * - Icone SVG + animazioni fluide (no emoji stutter)
 * - Meteo realtime più robusto + molte condizioni
 * - Grafici “meteo app” + storico via localStorage
 * - Grafici configurabili + auto-adattivi
 * Custom element: weather-station-card
 */

class WSCCard extends HTMLElement {
  static VERSION = "2.0.3";

  constructor() {
    super();
    this._hass = null;
    this._config = null;

    this._ui = {
      showCharts: false,
      showDetails: false,
    };

    // key -> [{t,v}] (in RAM)
    this._series = new Map();

    // key -> persisted points (localStorage)
    this._storeKey = null;
    this._persist = null;

    this._rafDraw = null;

    this._lastRainEvent = null;
    this._lastRainTs = 0;

    this._lastSampleTs = 0;

    this._onToggleCharts = this._onToggleCharts.bind(this);
    this._onToggleDetails = this._onToggleDetails.bind(this);
  }

  setConfig(config) {
    if (!config || !config.weather_entity) {
      throw new Error('Devi specificare obbligatoriamente la "weather_entity" (es: weather.casa)');
    }
// Defaults + override utente
    this._config = {
      // UI
      nome: "Stazione Meteo",
      mostra_nome: true,
      mostra_orologio: false,
      mostra_data: false,

      // Sampling & History
      sample_interval_sec: 60,     // ogni quanto campionare (per storico+grafici)
      history_hours: 24,           // quante ore tenere in localStorage
      smoothing: 0.22,             // 0..0.5 (più alto = più smoothed)

      // Forecast
      forecast_days: 5,
      forecast_hours: 24,

      // Condition thresholds (tweakabili)
      rain_rate_drizzle: 0.2,      // mm/h
      rain_rate_light: 1.0,
      rain_rate_moderate: 3.0,
      rain_rate_heavy: 8.0,
      rain_rate_violent: 20.0,

      windy_kmh: 25,
      very_windy_kmh: 45,

      fog_hum: 92,
      mist_hum: 86,

      sunny_uv: 1,
      sunny_lux: 4000,
      sunny_solar: 90,

      // SENSORS (null-safe)
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

      // METEO (OBBLIGATORIO): usato SOLO per condizione realtime + forecast
      weather_entity: null,

      // CHARTS: se non li metti, fa auto-detect dei principali disponibili
      // charts: [{ key:"temp", label:"Temperatura", entity:"sensor.xxx", unit:"°C" }, ...],

      ...config,
    };

    // chiave storage stabile (per più istanze)
    this._storeKey = `wscpro:${this._hash(`${this._config.nome}|${this._config.weather_entity}`)}`;
    this._persist = this._loadPersist();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    // campiona “a intervalli” (non ogni render)
    const now = Date.now();
    const interval = Math.max(10, Number(this._config?.sample_interval_sec ?? 60)) * 1000;
    if (!this._lastSampleTs || (now - this._lastSampleTs) >= interval) {
      this._lastSampleTs = now;
      this._sampleAll();        // aggiornamento serie + persist
      this._savePersist();      // scrive localStorage
    }

    this._render();
  }

  getCardSize() {
    return (this._ui.showCharts ? 8 : 4) + (this._ui.showDetails ? 6 : 0);
  }

  /* ===================== Helpers ===================== */

  _hash(str) {
    // hash semplice deterministico
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

  _isDaytime() {
    // senza sunrise/sunset: stima robusta con luce/uv/solar
    const uv = this._num(this._config.uv) ?? 0;
    const lux = this._num(this._config.lux) ?? 0;
    const solar = this._num(this._config.radiazione_solare) ?? 0;
    return (uv >= 0.5) || (lux >= 200) || (solar >= 10);
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

    // prune beyond history_hours
    const keepMs = Math.max(1, Number(this._config.history_hours ?? 24)) * 3600 * 1000;
    const minT = Date.now() - keepMs;
    while (arr.length && arr[0].t < minT) arr.shift();

    // cap hard (anti-quota)
    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  }

  _getHistory(key) {
    const arr = this._persist?.series?.[key] ?? [];
    return Array.isArray(arr) ? arr : [];
  }

  _trend(key, minutes = 90) {
    // ritorna delta negli ultimi N minuti (se possibile)
    const arr = this._getHistory(key);
    if (arr.length < 2) return null;
    const now = Date.now();
    const fromT = now - minutes * 60 * 1000;
    let a = null;
    let b = null;

    // a = primo >= fromT, b = ultimo
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].t >= fromT) { a = arr[i]; break; }
    }
    b = arr[arr.length - 1];
    if (!a || !b) return null;
    const d = b.v - a.v;
    return Number.isFinite(d) ? d : null;
  }

  /* ===================== Rain realtime ===================== */

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
    if (rate > 0.05) return true;
    return (Date.now() - this._lastRainTs) < 6 * 60 * 1000;
  }

  /* ===================== Condition logic (upgrade) ===================== */

  _conditionFromWeatherEntity() {
    // opzionale: se l'utente fornisce weather_entity, usalo (più affidabile se ben configurato)
    const we = this._config.weather_entity;
    if (!we) return null;
    const s = this._state(we);
    if (!s) return null;
    const k = String(s.state || "").toLowerCase();
    return { src: "weather", k };
  }

  _condition() {
    this._updateRainEvent();

    // optional weather override
    const w = this._conditionFromWeatherEntity();
    if (w) return this._mapWeatherEntityToCondition(w.k);

    const isDay = this._isDaytime();

    const t = this._num(this._config.temperatura);
    const hum = this._num(this._config.umidita);
    const wind = this._num(this._config.velocita_vento) ?? 0;
    const gust = this._num(this._config.raffica_vento) ?? 0;

    const rainRate = this._num(this._config.tasso_pioggia) ?? 0;
    const raining = this._isRainingNow();

    const uv = this._num(this._config.uv) ?? 0;
    const lux = this._num(this._config.lux) ?? 0;
    const solar = this._num(this._config.radiazione_solare) ?? 0;

    const press = this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta);
    const pressTrend = (press !== null) ? (this._trend("press", 120) ?? this._trend("press", 90) ?? 0) : 0; // hPa
    // tipico “calo rapido” se < -1.5 hPa in ~2 ore (euristica)
    const pressFallingFast = pressTrend !== null && pressTrend <= -1.5;

    const windy = wind >= this._config.windy_kmh || gust >= (this._config.windy_kmh + 10);
    const veryWindy = wind >= this._config.very_windy_kmh || gust >= (this._config.very_windy_kmh + 10);

    // luce -> sereno/nuvole
// luce presente
    const lightPresent =
      (uv >= this._config.sunny_uv) ||
      (solar >= this._config.sunny_solar) ||
      (lux >= this._config.sunny_lux);
    
    // pressione stabile o in lieve aumento
    const pressureStable =
      pressTrend === null || pressTrend >= -0.6;
    
    // umidità compatibile con cielo sereno
    const dryEnough =
      hum !== null && hum <= 75;
    
    // rapporto UV / radiazione → sole diretto vs diffuso
    const directSun =
      uv >= 1.2 && solar >= 150;
    
    // SERENO vero (molto più restrittivo)
    const sunny =
      !raining &&
      lightPresent &&
      directSun &&
      dryEnough &&
      pressureStable;

    const dark = !sunny && (uv < 0.2 && lux < 200 && solar < 10);

    // nebbia/foschia
    const fog = !raining && hum !== null && hum >= this._config.fog_hum && dark && wind < 4;
    const mist = !raining && !fog && hum !== null && hum >= this._config.mist_hum && dark && wind < 7;

    // precipitazioni: classi
    const drizzle = raining && rainRate > 0 && rainRate < this._config.rain_rate_drizzle;
    const lightRain = raining && rainRate >= this._config.rain_rate_drizzle && rainRate < this._config.rain_rate_light;
    const moderateRain = raining && rainRate >= this._config.rain_rate_light && rainRate < this._config.rain_rate_moderate;
    const heavyRain = raining && rainRate >= this._config.rain_rate_moderate && rainRate < this._config.rain_rate_heavy;
    const violentRain = raining && rainRate >= this._config.rain_rate_heavy;

    // neve/nevischio/grandine (stima da T + precipitazione)
    const snow = raining && t !== null && t <= 0.5;
    const sleet = raining && t !== null && t > 0.5 && t <= 2.5;

    // grandine: difficile senza sensore. Stima: pioggia intensa + raffiche + temp bassa ma > 0
    const hail = raining && t !== null && t > 0 && t <= 6 && (violentRain || (heavyRain && veryWindy));

    // temporale: pioggia + vento + calo pressione (euristica)
    const thunder = raining && (violentRain || heavyRain || (veryWindy && moderateRain)) && pressFallingFast;

    // nuvolosità: senza cloud sensor, euristica con luce + umidità
    const partly =
      !raining &&
      lightPresent &&
      !sunny &&
      hum !== null &&
      hum >= 55 &&
      hum <= 88;

    const cloudy = !raining && !sunny && !fog && !mist;

    // estremi (warning)
    const hot = t !== null && t >= 33;
    const cold = t !== null && t <= -3;

    // ORDER (più specifico -> più generico)
    if (thunder) return this._cond("temporale", "Temporale", "thunder");
    if (hail)    return this._cond("grandine", "Grandine", "hail");
    if (snow)    return this._cond("neve", "Neve", "snow");
    if (sleet)   return this._cond("nevischio", "Nevischio", "sleet");

    if (violentRain)  return this._cond(isDay ? "pioggia_forte" : "pioggia_forte_notte", "Pioggia forte", "rain_heavy");
    if (heavyRain)    return this._cond(isDay ? "pioggia" : "pioggia_notte", "Pioggia", "rain");
    if (moderateRain) return this._cond(isDay ? "pioggia" : "pioggia_notte", "Pioggia", "rain");
    if (lightRain)    return this._cond(isDay ? "pioggia_debole" : "pioggia_debole_notte", "Pioggia debole", "rain_light");
    if (drizzle)      return this._cond(isDay ? "pioviggine" : "pioviggine_notte", "Pioviggine", "drizzle");

    if (fog)    return this._cond(isDay ? "nebbia" : "nebbia_notte", "Nebbia", "fog");
    if (mist)   return this._cond(isDay ? "foschia" : "foschia_notte", "Foschia", "mist");

    if (veryWindy) return this._cond(isDay ? "molto_ventoso" : "molto_ventoso_notte", "Molto ventoso", "wind_strong");
    if (windy)     return this._cond(isDay ? "ventoso" : "ventoso_notte", "Ventoso", "wind");

    if (sunny && !partly) return this._cond(isDay ? "sereno" : "sereno_notte", isDay ? "Sereno" : "Sereno (notte)", isDay ? "clear_day" : "clear_night");
    if (partly)           return this._cond(isDay ? "parz_nuvoloso" : "parz_nuvoloso_notte", "Parz. nuvoloso", isDay ? "partly_day" : "partly_night");

    if (cloudy) return this._cond(isDay ? "coperto" : "coperto_notte", "Coperto", "cloudy");

    // fallback
    return this._cond(isDay ? "variabile" : "variabile_notte", "Variabile", isDay ? "partly_day" : "partly_night");
  }

  _cond(k, label, iconKey) {
    return { k, l: label, iconKey };
  }

  _mapWeatherEntityToCondition(state) {
    // mapping comune HA: clear-night, clear, cloudy, partlycloudy, rainy, pouring, lightning, lightning-rainy, snowy, snowy-rainy, fog, windy, windy-variant, exceptional
    const s = (state || "").toLowerCase();
    const day = this._isDaytime();

    if (s.includes("lightning")) return this._cond("temporale", "Temporale", "thunder");
    if (s.includes("snowy")) return this._cond("neve", "Neve", "snow");
    if (s.includes("fog")) return this._cond(day ? "nebbia" : "nebbia_notte", "Nebbia", "fog");
    if (s.includes("pour")) return this._cond(day ? "pioggia_forte" : "pioggia_forte_notte", "Pioggia forte", "rain_heavy");
    if (s.includes("rain")) return this._cond(day ? "pioggia" : "pioggia_notte", "Pioggia", "rain");
    if (s.includes("cloudy")) return this._cond(day ? "coperto" : "coperto_notte", "Coperto", "cloudy");
    if (s.includes("partly")) return this._cond(day ? "parz_nuvoloso" : "parz_nuvoloso_notte", "Parz. nuvoloso", day ? "partly_day" : "partly_night");
    if (s.includes("clear-night")) return this._cond("sereno_notte", "Sereno (notte)", "clear_night");
    if (s.includes("clear")) return this._cond("sereno", "Sereno", "clear_day");
    if (s.includes("wind")) return this._cond(day ? "ventoso" : "ventoso_notte", "Ventoso", "wind");
    return this._cond(day ? "variabile" : "variabile_notte", "Variabile", day ? "partly_day" : "partly_night");
  }


/* ===================== Weather & Forecast ===================== */

_weatherState() {
  const we = this._config.weather_entity;
  if (!we) return null;
  const s = this._state(we);
  if (!s) return null;
  return s;
}

_weatherAttr() {
  const s = this._weatherState();
  return s ? (s.attributes || {}) : {};
}

_getForecastRaw() {
  const a = this._weatherAttr();
  const fc = a.forecast;
  return Array.isArray(fc) ? fc : [];
}

_isHourlyForecast(fc) {
  // Heuristic: if first two entries < 3h apart => hourly
  if (!Array.isArray(fc) || fc.length < 2) return false;
  const t0 = Date.parse(fc[0].datetime || fc[0].datetime_local || fc[0].time || "");
  const t1 = Date.parse(fc[1].datetime || fc[1].datetime_local || fc[1].time || "");
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return false;
  const dt = Math.abs(t1 - t0);
  return dt <= 3 * 3600 * 1000;
}

_pickHourlyForecast(hours = 24) {
  const fc = this._getForecastRaw();
  if (!fc.length) return [];
  const hourly = this._isHourlyForecast(fc) ? fc : [];
  return hourly.slice(0, Math.max(1, Number(hours || 24)));
}

_pickDailyForecast(days = 5) {
  const fc = this._getForecastRaw();
  if (!fc.length) return [];
  // If hourly forecast, compress to unique dates taking first occurrence per day.
  const out = [];
  const seen = new Set();
  for (const f of fc) {
    const dt = Date.parse(f.datetime || f.datetime_local || f.time || "");
    if (!Number.isFinite(dt)) continue;
    const d = new Date(dt);
    const key = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= Math.max(1, Number(days || 5))) break;
  }
  return out;
}

_hasAnyStationSensor() {
  const c = this._config || {};
  const ids = [
    c.temperatura, c.umidita,
    c.velocita_vento, c.raffica_vento, c.direzione_vento,
    c.tasso_pioggia, c.pioggia_evento,
    c.radiazione_solare, c.lux, c.uv,
    c.punto_rugiada, c.vpd,
    c.pressione_relativa, c.pressione_assoluta,
    c.temperatura_interna, c.umidita_interna,
    c.pioggia_giornaliera, c.pioggia_settimanale, c.pioggia_mensile, c.pioggia_annuale
  ].filter(Boolean);
  return ids.some((id) => !!this._state(id));
}

_onlyWeatherMode() {
  // Only-weather mode = weather_entity set AND no station sensors configured/available
  // In this mode we hide buttons, charts, details, and show only forecasts.
  const hasWe = !!this._config?.weather_entity && !!this._weatherState();
  if (!hasWe) return false;
  return !this._hasAnyStationSensor();
}

_btnIcon(kind) {
  // Minimal inline SVG (crisp + consistent)
  const common = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
  if (kind === "charts") {
    return `<svg ${common}><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3-3 3 2 5-6"/></svg>`;
  }
  return `<svg ${common}><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`;
}

  _theme(k) {
    // palette più “app meteo” (glow più soft)
    const t = {
      sereno:                ["#070B14", "#0B2A4A", "rgba(56,189,248,.25)"],
      sereno_notte:          ["#050814", "#0A163A", "rgba(147,197,253,.20)"],

      parz_nuvoloso:         ["#070B14", "#12324F", "rgba(253,224,71,.18)"],
      parz_nuvoloso_notte:   ["#050814", "#0B1E3A", "rgba(125,211,252,.16)"],

      variabile:             ["#070B14", "#101E3A", "rgba(148,163,184,.18)"],
      variabile_notte:       ["#050814", "#0B1430", "rgba(148,163,184,.14)"],

      coperto:               ["#070B14", "#0B1220", "rgba(148,163,184,.16)"],
      coperto_notte:         ["#050814", "#0A1020", "rgba(148,163,184,.12)"],

      pioviggine:            ["#050B18", "#0B2A4A", "rgba(56,189,248,.18)"],
      pioviggine_notte:      ["#040814", "#08223A", "rgba(56,189,248,.14)"],

      pioggia_debole:        ["#050B18", "#0B2A4A", "rgba(56,189,248,.22)"],
      pioggia_debole_notte:  ["#040814", "#08223A", "rgba(56,189,248,.18)"],

      pioggia:               ["#040B18", "#06355F", "rgba(56,189,248,.26)"],
      pioggia_notte:         ["#030714", "#06284A", "rgba(56,189,248,.22)"],

      pioggia_forte:         ["#020816", "#052B55", "rgba(34,211,238,.30)"],
      pioggia_forte_notte:   ["#020611", "#04213E", "rgba(34,211,238,.26)"],

      temporale:             ["#020616", "#1A1035", "rgba(168,85,247,.22)"],

      neve:                  ["#050814", "#0B1B2E", "rgba(226,232,240,.18)"],
      nevischio:             ["#050814", "#0B1B2E", "rgba(226,232,240,.16)"],
      grandine:              ["#040714", "#0A1A2E", "rgba(226,232,240,.14)"],

      nebbia:                ["#060812", "#121826", "rgba(226,232,240,.14)"],
      nebbia_notte:          ["#040610", "#0E1422", "rgba(226,232,240,.12)"],
      foschia:               ["#060812", "#121826", "rgba(226,232,240,.12)"],
      foschia_notte:         ["#040610", "#0E1422", "rgba(226,232,240,.10)"],

      ventoso:               ["#040814", "#0B1E3A", "rgba(165,180,252,.16)"],
      ventoso_notte:         ["#030611", "#091A33", "rgba(165,180,252,.14)"],
      molto_ventoso:         ["#040814", "#0B1E3A", "rgba(129,140,248,.18)"],
      molto_ventoso_notte:   ["#030611", "#091A33", "rgba(129,140,248,.16)"],
    };
    return t[k] ?? t.variabile;
  }

  /* ===================== Sampling series ===================== */

  _pushSeries(key, value) {
    if (!Number.isFinite(value)) return;
    const arr = this._series.get(key) ?? [];
    const now = Date.now();
    arr.push({ t: now, v: value });

    // keep max 240 points in RAM
    while (arr.length > 240) arr.shift();
    this._series.set(key, arr);
  }

  _sampleAll() {
    const now = Date.now();

    const temp = this._num(this._config.temperatura);
    const wind = this._num(this._config.velocita_vento);
    const rain = this._num(this._config.tasso_pioggia);
    const solar = this._num(this._config.radiazione_solare);
    const press = this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta);
    const hum = this._num(this._config.umidita);

    // base keys (usati da condition/trend + default charts)
    if (temp !== null)  { this._pushSeries("temp", temp);  this._persistPush("temp", now, temp); }
    if (wind !== null)  { this._pushSeries("wind", wind);  this._persistPush("wind", now, wind); }
    if (rain !== null)  { this._pushSeries("rain", rain);  this._persistPush("rain", now, rain); }
    if (solar !== null) { this._pushSeries("solar", solar); this._persistPush("solar", now, solar); }
    if (press !== null) { this._pushSeries("press", press); this._persistPush("press", now, press); }
    if (hum !== null)   { this._pushSeries("hum", hum);   this._persistPush("hum", now, hum); }

    // charts configurabili: campiona anche quelli
    for (const ch of this._getCharts()) {
      const v = this._num(ch.entity);
      if (v !== null) {
        this._pushSeries(ch.key, v);
        this._persistPush(ch.key, now, v);
      }
    }
  }

  _getCharts() {
    // se l’utente passa charts: usali
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

    // auto-detect “bello” (meteo app)
    const out = [];
    const add = (key, label, entity, unit="") => {
      if (!entity) return;
      if (!this._state(entity)) return; // solo se esiste
      out.push({ key, label, entity, unit });
    };

    add("temp", "Temperatura", this._config.temperatura, "°C");
    add("hum", "Umidità", this._config.umidita, "%");
    add("wind", "Vento", this._config.velocita_vento, "km/h");
    add("rain", "Pioggia", this._config.tasso_pioggia, "mm/h");
    add("solar", "Radiazione", this._config.radiazione_solare, "W/m²");
    add("press", "Pressione", this._config.pressione_relativa ?? this._config.pressione_assoluta, "hPa");
    add("uv", "UV", this._config.uv, "");
    add("lux", "Lux", this._config.lux, "");
    add("vpd", "VPD", this._config.vpd, "hPa");

    // limita per non “esagerare” su mobile
    return out.slice(0, 6);
  }

  /* ===================== Charts render (futuristic) ===================== */

  _smoothSeries(data, alpha) {
    // exponential smoothing (EMA)
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
if (!raw || raw.length < 2) return;

// View state per chart
if (!this._chartView) this._chartView = new Map();
if (!this._chartView.has(key)) {
  // default window: last 6 hours (or less if history smaller)
  this._chartView.set(key, { windowMs: 6 * 3600 * 1000, offsetMs: 0, hoverX: null, dragging: false, dragStartX: 0, dragStartOffset: 0 });
}
const view = this._chartView.get(key);

const ctx = canvas.getContext("2d", { alpha: true });
const dpr = devicePixelRatio || 1;

const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
if (canvas.width !== w) canvas.width = w;
if (canvas.height !== h) canvas.height = h;

ctx.clearRect(0, 0, w, h);

// Determine time range
const tMinAll = raw[0].t;
const tMaxAll = raw[raw.length - 1].t;

const totalMs = Math.max(1, tMaxAll - tMinAll);
const windowMs = Math.min(Math.max(30 * 60 * 1000, view.windowMs), totalMs); // 30min..total
const maxOffset = Math.max(0, totalMs - windowMs);
const offset = this._clamp(view.offsetMs, 0, maxOffset);
view.offsetMs = offset;

const tStart = tMinAll + (totalMs - windowMs) - offset; // default anchored to end, offset pans backwards
const tEnd = tStart + windowMs;

// Filter points in window (with small padding)
const padMs = windowMs * 0.02;
let data = raw.filter(p => p.t >= (tStart - padMs) && p.t <= (tEnd + padMs));
if (data.length < 2) data = raw.slice(-Math.min(raw.length, 2));

// Downsample to max points
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

const padL = 44 * dpr;
const padR = 10 * dpr;
const padT = 10 * dpr;
const padB = 26 * dpr;

const gx0 = padL, gx1 = w - padR;
const gy0 = padT, gy1 = h - padB;

const X = (t) => gx0 + ((t - tStart) / windowMs) * (gx1 - gx0);
const Y = (v) => gy1 - ((v - min) / span) * (gy1 - gy0);

// Grid
ctx.save();
ctx.globalAlpha = 0.10;
ctx.strokeStyle = "#ffffff";
ctx.lineWidth = 1 * dpr;
const gridN = 4;
for (let i = 0; i <= gridN; i++) {
  const y = gy0 + (i / gridN) * (gy1 - gy0);
  ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke();
}
ctx.restore();

// Area
const grad = ctx.createLinearGradient(0, gy0, 0, gy1);
grad.addColorStop(0, "rgba(255,255,255,.18)");
grad.addColorStop(1, "rgba(255,255,255,.02)");

ctx.beginPath();
ctx.moveTo(X(data[0].t), Y(data[0].v));
for (let i = 1; i < data.length; i++) ctx.lineTo(X(data[i].t), Y(data[i].v));
ctx.lineTo(X(data[data.length - 1].t), gy1);
ctx.lineTo(X(data[0].t), gy1);
ctx.closePath();
ctx.fillStyle = grad;
ctx.fill();

// Line
ctx.save();
ctx.lineWidth = 2.2 * dpr;
ctx.lineJoin = "round";
ctx.lineCap = "round";
ctx.strokeStyle = "#ffffff";
ctx.shadowColor = "rgba(255,255,255,.25)";
ctx.shadowBlur = 10 * dpr;
ctx.beginPath();
ctx.moveTo(X(data[0].t), Y(data[0].v));
for (let i = 1; i < data.length; i++) ctx.lineTo(X(data[i].t), Y(data[i].v));
ctx.stroke();
ctx.restore();

// Axes labels
ctx.save();
ctx.font = `${11 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
ctx.fillStyle = "rgba(255,255,255,.70)";

// Y labels
ctx.textAlign = "right";
const yTicks = 3;
for (let i = 0; i <= yTicks; i++) {
  const v = min + (span * i / yTicks);
  const y = Y(v);
  ctx.fillText(v.toFixed(1) + (unit || ""), gx0 - 8 * dpr, y + 4 * dpr);
}

// X labels (time)
ctx.textAlign = "center";
const xTicks = 4;
for (let i = 0; i <= xTicks; i++) {
  const tt = tStart + (windowMs * i / xTicks);
  const d = new Date(tt);
  const label = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  const x = gx0 + (i / xTicks) * (gx1 - gx0);
  ctx.fillText(label, x, h - 6 * dpr);
}
ctx.restore();

// Hover tooltip
if (view.hoverX != null) {
  const hx = this._clamp(view.hoverX, gx0, gx1);
  const ht = tStart + ((hx - gx0) / (gx1 - gx0)) * windowMs;

  // find nearest point
  let best = data[0];
  let bestDist = Math.abs(best.t - ht);
  for (let i = 1; i < data.length; i++) {
    const d = Math.abs(data[i].t - ht);
    if (d < bestDist) { best = data[i]; bestDist = d; }
  }

  const px = X(best.t);
  const py = Y(best.v);

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath(); ctx.moveTo(px, gy0); ctx.lineTo(px, gy1); ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(px, py, 3.2 * dpr, 0, Math.PI * 2); ctx.fill();

  const tLab = new Date(best.t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  const vLab = (Number.isFinite(best.v) ? best.v.toFixed(1) : "—") + (unit || "");
  const txt = `${tLab} • ${vLab}`;

  ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  const tw = ctx.measureText(txt).width + 16 * dpr;
  const th = 24 * dpr;

  let bx = px - tw / 2;
  bx = this._clamp(bx, gx0, gx1 - tw);
  const by = gy0 + 6 * dpr;

  ctx.globalAlpha = 0.20;
  ctx.fillStyle = "#ffffff";
  this._roundRect(ctx, bx, by, tw, th, 12 * dpr);
  ctx.fill();

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "#000000";
  ctx.fillText(txt, bx + 8 * dpr, by + 16 * dpr);

  ctx.restore();
}

// Attach interactions once
if (!canvas._wscBound) {
  canvas._wscBound = true;

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * dpr;
    const v = this._chartView.get(key);
    v.hoverX = x;
    this._drawChart(canvas, key, unit);
  };

  const onLeave = () => {
    const v = this._chartView.get(key);
    v.hoverX = null;
    this._drawChart(canvas, key, unit);
  };

  const onDown = (e) => {
    const v = this._chartView.get(key);
    v.dragging = true;
    v.dragStartX = e.clientX;
    v.dragStartOffset = v.offsetMs;
    canvas.setPointerCapture?.(e.pointerId);
  };

  const onUp = (e) => {
    const v = this._chartView.get(key);
    v.dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  };

  const onDrag = (e) => {
    const v = this._chartView.get(key);
    if (!v.dragging) return;
    const dx = (e.clientX - v.dragStartX); // px
    const pxSpan = Math.max(1, canvas.clientWidth);
    const deltaMs = (dx / pxSpan) * v.windowMs;
    v.offsetMs = this._clamp(v.dragStartOffset + deltaMs, 0, maxOffset);
    this._drawChart(canvas, key, unit);
  };

  const onWheel = (e) => {
    // zoom with wheel / trackpad
    e.preventDefault();
    const v = this._chartView.get(key);
    const factor = e.deltaY > 0 ? 1.12 : 0.88;
    v.windowMs = this._clamp(v.windowMs * factor, 30 * 60 * 1000, totalMs);
    this._drawChart(canvas, key, unit);
  };

  canvas.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointerleave", onLeave, { passive: true });
  canvas.addEventListener("pointerdown", onDown, { passive: true });
  canvas.addEventListener("pointerup", onUp, { passive: true });
  canvas.addEventListener("pointercancel", onUp, { passive: true });
  canvas.addEventListener("pointermove", onDrag, { passive: true });
  canvas.addEventListener("wheel", onWheel, { passive: false });
}
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

  _scheduleDrawCharts() {
    cancelAnimationFrame(this._rafDraw);
    this._rafDraw = requestAnimationFrame(() => {
      if (!this.shadowRoot) return;
      const charts = this._getCharts();
      for (const ch of charts) {
        const el = this.shadowRoot.querySelector(`#wsc_c_${this._escId(ch.key)}`);
        if (el) this._drawChart(el, ch.key, ch.unit);
      }
    });
  }

  _escId(s) {
    // id safe
    return String(s).replace(/[^a-zA-Z0-9_]/g, "_");
  }

  /* ===================== UI actions ===================== */

  _onToggleCharts() {
    this._ui.showCharts = !this._ui.showCharts;
    this._render();
  }

  _onToggleDetails() {
    this._ui.showDetails = !this._ui.showDetails;
    this._render();
  }

  /* ===================== Rendering helpers ===================== */

  _badge(text) {
    return `<span class="badge">${this._esc(text)}</span>`;
  }

  _tile(title, value, hint = "") {
    if (value === null || value === undefined || value === "") return "";
    return `
      <div class="tile" title="${this._esc(hint)}">
        <div class="k">${this._esc(title)}</div>
        <div class="v">${value}</div>
      </div>
    `;
  }

  _iconSVG(key) {
    // SVG minimal, animabile, leggero.
    // (Se vuoi, poi facciamo un set ancora più “premium” con dettagli)
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
      case "sleet":
        return wrap(`
          <g ${common} class="cloudFront">
            <path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4A8 8 0 0 0 16 38z"/>
          </g>
          <g ${common} class="mix">
            <path d="M22 44v10"/><path d="M32 46l0 10"/><path d="M42 44v10"/>
            <path d="M32 50l-3 3"/><path d="M32 50l3 3"/>
          </g>
        `, "snow");
      case "hail":
        return wrap(`
          <g ${common} class="cloudFront">
            <path d="M14 36h34a11 11 0 0 0 0-22 16 16 0 0 0-31 4A9 9 0 0 0 14 36z"/>
          </g>
          <g class="hail" fill="currentColor" opacity=".9">
            <circle cx="22" cy="48" r="2.6"/><circle cx="32" cy="52" r="2.8"/><circle cx="42" cy="48" r="2.6"/>
          </g>
        `, "hail");
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
    const [bgA, bgB, glow] = this._theme(cond.k);
    const now = this._now();
    const onlyWeather = this._onlyWeatherMode();
    const wattr = this._weatherAttr();
    const fcHourly = this._pickHourlyForecast(this._config.forecast_hours ?? 24);
    const fcDaily = this._pickDailyForecast(this._config.forecast_days ?? 5);

    const temp = this._num(this._config.temperatura);
    const hum = this._num(this._config.umidita);
    const wind = this._num(this._config.velocita_vento);
    const gust = this._num(this._config.raffica_vento);
    const dir = this._num(this._config.direzione_vento);

    const rainRate = this._num(this._config.tasso_pioggia);
    const rainingNow = this._isRainingNow();

    const uv = this._num(this._config.uv);
    const lux = this._num(this._config.lux);
    const solar = this._num(this._config.radiazione_solare);

    const dew = this._num(this._config.punto_rugiada);
    const vpd = this._num(this._config.vpd);

    const press = this._num(this._config.pressione_relativa) ?? this._num(this._config.pressione_assoluta);
    const pressTrend = (press !== null) ? (this._trend("press", 120) ?? this._trend("press", 90)) : null;

    const tIn = this._num(this._config.temperatura_interna);
    const hIn = this._num(this._config.umidita_interna);

    const rd = this._num(this._config.pioggia_giornaliera);
    const rw = this._num(this._config.pioggia_settimanale);
    const rm = this._num(this._config.pioggia_mensile);
    const ry = this._num(this._config.pioggia_annuale);

    // badges (1 riga)
    const badges = [];
    badges.push(`⟡ ${cond.l}`);
    if (rainingNow && rainRate !== null) badges.push(`🌧️ ${rainRate.toFixed(1)} mm/h`);
    if (hum !== null) badges.push(`💧 ${Math.round(hum)}%`);
    if (wind !== null) badges.push(`🌬️ ${wind.toFixed(1)} km/h`);
   

    const badgeHTML = badges.map(b => this._badge(b)).join("");

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
      this._tile("Pressione", press === null ? null : `${press.toFixed(1)} hPa${pressTrend !== null ? ` (${pressTrend >= 0 ? "+" : ""}${pressTrend.toFixed(1)} /2h)` : ""}`, "Pressione atmosferica e trend"),

      this._tile("Punto di rugiada", dew === null ? null : `${dew.toFixed(1)}°`, "Condensa / saturazione"),
      this._tile("VPD", vpd === null ? null : `${vpd.toFixed(2)} hPa`, "Deficit di pressione di vapore"),
      this._tile("UV", uv === null ? null : `${Math.round(uv)}`, "Indice UV"),
      this._tile("Radiazione", solar === null ? null : `${solar.toFixed(0)} W/m²`, "Radiazione solare"),
      this._tile("Lux", lux === null ? null : `${lux.toFixed(0)}`, "Luminosità"),
      
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

    const showName = !!this._config.mostra_nome;
    const showClock = !!this._config.mostra_orologio;
    const showDate = !!this._config.mostra_data;

    const charts = this._getCharts();
    const chartsHTML = charts.map(ch => `
      <div class="chart">
        <div class="cHead">
          <span>${this._esc(ch.label)}</span>
          <span class="cMeta">${this._esc(ch.unit || "")}</span>
        </div>
        <canvas class="spark" id="wsc_c_${this._escId(ch.key)}"></canvas>
      </div>
    `).join("");

    const iconSVG = this._iconSVG(cond.iconKey);

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
      radial-gradient(900px 560px at 15% 10%, ${glow}, transparent 62%),
      linear-gradient(135deg, ${bgA}, ${bgB});
    box-shadow: 0 30px 70px rgba(0,0,0,.38);
  }

  .top{ display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
  .temp{ font-size:78px; font-weight:950; letter-spacing:-1px; line-height:1; }
  .meta{ margin-top:8px; opacity:.90; font-size:13px; }

  /* Time/Date: più marcati */
  .clockLine{
    margin-top:8px;
    display:flex;
    gap:10px;
    align-items:baseline;
    font-weight:900;
    letter-spacing:.2px;
  }
  .clock{
    font-size:32px;
    font-weight:950;
    letter-spacing:1px;
    opacity:.96;
    text-shadow:0 12px 28px rgba(0,0,0,.45);
  }
  .date{
    font-size:15px;
    font-weight:800;
    opacity:.85;
  }

  /* Badges: 1 riga */
  .badges{
    margin-top:12px;
    display:flex;
    flex-wrap:nowrap;
    gap:8px;
    overflow-x:auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .badges::-webkit-scrollbar{ display:none; }

  .badge{
    white-space:nowrap;
    background: rgba(255,255,255,.12);
    border:1px solid rgba(255,255,255,.10);
    padding:6px 12px;
    border-radius:999px;
    font-size:12px;
    backdrop-filter: blur(12px);
  }

  /* Icone SVG (super fluide) */
  .icon{
    width:86px;
    height:86px;
    color:#fff;
    filter: drop-shadow(0 18px 32px rgba(0,0,0,.38));
    will-change: transform;
    transform: translate3d(0,0,0);
    animation: floaty 6.5s cubic-bezier(.4,0,.2,1) infinite;
  }
  @keyframes floaty{
    0%,100%{ transform: translate3d(0,0,0) scale(1); }
    50%{ transform: translate3d(0,-10px,0) scale(1.02); }
  }

  /* micro-animazioni per classi */
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
  @keyframes wind{
    0%,100%{ transform: translateX(0); opacity:.85; }
    50%{ transform: translateX(6px); opacity:1; }
  }

  .wscSvg.fog .fogLines{ animation: fog 4.2s ease-in-out infinite; }
  @keyframes fog{
    0%,100%{ transform: translateX(0); opacity:.65; }
    50%{ transform: translateX(6px); opacity:.95; }
  }

  .wscSvg.snow .flakes{ animation: snow 2.9s ease-in-out infinite; }
  @keyframes snow{
    0%,100%{ transform: translateY(0); opacity:.75; }
    50%{ transform: translateY(4px); opacity:1; }
  }

  .actions{
    margin-top:14px;
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
  .btn.on{
    background: rgba(255,255,255,.16);
    border-color: rgba(255,255,255,.26);
  }

  .grid{
    margin-top:16px;
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap:14px;
  }
  .tile{
    background: rgba(255,255,255,.10);
    border: 1px solid rgba(255,255,255,.08);
    border-radius:18px;
    padding:14px;
    backdrop-filter: blur(14px);
  }
  .k{ font-size:12px; opacity:.74; }
  .v{ margin-top:6px; font-size:18px; font-weight:950; }

  .dirWrap{ display:flex; align-items:center; gap:10px; }
  .dir{
    display:inline-block;
    font-size:22px;
    filter: drop-shadow(0 8px 14px rgba(0,0,0,.35));
    transition: transform .6s ease;
  }
  .dirDeg{ font-size:12px; opacity:.75; }

  .charts{
    margin-top:14px;
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap:14px;
  }
  .chart{
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.08);
    border-radius:18px;
    padding:12px;
    backdrop-filter: blur(14px);
  }
  .cHead{
    font-size:12px;
    opacity:.82;
    margin-bottom:10px;
    display:flex;
    justify-content:space-between;
    gap:10px;
  }
  .cMeta{ opacity:.7; }
  canvas.spark{ width:100%; height:92px; display:block; }


/* Forecast (only-weather mode) */
.forecastWrap{ margin-top:16px; }
.fTitle{ font-size:12px; font-weight:900; opacity:.82; margin:10px 0 8px; letter-spacing:.2px; }
.forecastHourly{
  display:flex;
  gap:10px;
  overflow-x:auto;
  -webkit-overflow-scrolling:touch;
  scrollbar-width:none;
  padding-bottom:6px;
}
.forecastHourly::-webkit-scrollbar{ display:none; }
.hItem{
  min-width:72px;
  background: rgba(255,255,255,.10);
  border: 1px solid rgba(255,255,255,.08);
  border-radius:18px;
  padding:10px 10px;
  text-align:center;
  backdrop-filter: blur(14px);
}
.hT{ font-size:11px; opacity:.75; font-weight:800; }
.hI{ width:34px; height:34px; margin:6px auto 6px; color:#fff; }
.hI svg{ width:34px; height:34px; }
.hV{ font-size:14px; font-weight:950; }

.forecastDaily{
  display:flex;
  flex-direction:column;
  gap:10px;
}
.dItem{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  background: rgba(255,255,255,.10);
  border: 1px solid rgba(255,255,255,.08);
  border-radius:18px;
  padding:10px 12px;
  backdrop-filter: blur(14px);
}
.dDay{ font-size:12px; font-weight:950; opacity:.9; text-transform:capitalize; }
.dIcon{ width:34px; height:34px; color:#fff; }
.dIcon svg{ width:34px; height:34px; }
.dTemp{ display:flex; gap:10px; align-items:baseline; font-weight:950; }
.dTemp .hi{ font-size:16px; }
.dTemp .lo{ font-size:13px; opacity:.72; }
  .footer{
    margin-top:12px;
    display:flex;
    justify-content:space-between;
    font-size:11px;
    opacity:.6;
  }
  .bgIcon{
    position:absolute;
    right:-80px;
    top:-80px;
    width:360px;
    height:360px;
    opacity:0.14;
    pointer-events:none;
    filter: blur(1.5px);
    z-index:0;
  }
  
  .bgIcon svg{
    width:100%;
    height:100%;
    animation: bgFloat 18s ease-in-out infinite;
  }

  .gridInternal{
  margin-top:12px;
  opacity:.9;
  }

  .gridInternal .tile{
    background: rgba(255,255,255,.06);
  }

  @keyframes bgFloat{
    0%,100%{ transform: translateY(0) scale(1); }
    50%{ transform: translateY(24px) scale(1.03); }
  }
  
  /* porta il contenuto sopra */
  ha-card > *:not(.bgIcon){
    position:relative;
    z-index:2;
  }


  /* Responsive */
  @media (max-width: 420px) {
    ha-card { padding: 20px; border-radius: 26px; }
    .temp { font-size: 56px; }
    .icon { width:62px; height:62px; }
    .badge { font-size: 11px; padding: 5px 10px; }
    .btn { padding: 8px 12px; font-size: 12px; }
    canvas.spark{ height:86px; }
  }
  @media (max-width: 300px) {
    ha-card { padding: 16px; border-radius: 22px; }
    .temp { font-size: 42px; }
    .icon { width:46px; height:46px; }
    .meta { display:none; }
    .clockLine{ display:none; }
    .badge { font-size: 10px; padding: 4px 8px; }
    .btn { padding: 6px 10px; font-size: 11px; }
    .footer { font-size: 10px; }
  }
  .bgIcon{
    width:240px;
    height:240px;
    right:-50px;
    top:-50px;
  }
  .clock{
    font-size:24px;
  }

</style>

<ha-card>
  <div class="bgIcon bg-${cond.k}">
    ${iconSVG}
  </div>

  <div class="top">
    <div>
      <div class="temp">${temp === null ? "—" : temp.toFixed(1)}°</div>

      ${showName ? `<div class="meta">${this._esc(this._config.nome)}</div>` : ""}

      ${(showClock || showDate) ? `
        <div class="clockLine">
          ${showClock ? `<div class="clock">${now.time}</div>` : ""}
          ${showDate ? `<div class="date">${now.date}</div>` : ""}
        </div>
      ` : ""}

      ${onlyWeather ? "" : `<div class="badges">${badgeHTML}</div>`}
    </div>

    
  </div>

  ${onlyWeather ? "" : `
  <div class="actions">
    <button class="btn ${this._ui.showCharts ? "on" : ""}" id="wscBtnCharts" aria-label="Grafici">${this._btnIcon("charts")}</button>
    <button class="btn ${this._ui.showDetails ? "on" : ""}" id="wscBtnDetails" aria-label="Dettagli">${this._btnIcon("details")}</button>
  </div>
  `}

  ${(!onlyWeather && this._ui.showCharts) ? `
    <div class="charts">
      ${chartsHTML || `<div class="chart"><div class="cHead">Nessun sensore grafico configurato</div></div>`}
    </div>
  ` : ""}

${(!onlyWeather && this._ui.showDetails) ? `
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


${onlyWeather ? `
  <div class="forecastWrap">
    ${fcHourly && fcHourly.length ? `
      <div class="fTitle">Prossime ore</div>
      <div class="forecastHourly">
        ${fcHourly.slice(0, this._config.forecast_hours ?? 24).map((f) => {
          const t = new Date(f.datetime || f.datetime_local || f.time || Date.now());
          const lab = t.toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
          const c = this._mapWeatherEntityToCondition(f.condition || f.state || "");
          const tt = (f.temperature != null ? Math.round(Number(f.temperature)) : "—");
          return `
            <div class="hItem">
              <div class="hT">${this._esc(lab)}</div>
              <div class="hI">${this._iconSVG(c.iconKey)}</div>
              <div class="hV">${tt}°</div>
            </div>
          `;
        }).join("")}
      </div>
    ` : ""}

    ${fcDaily && fcDaily.length ? `
      <div class="fTitle">Prossimi giorni</div>
      <div class="forecastDaily">
        ${fcDaily.slice(0, this._config.forecast_days ?? 5).map((f) => {
          const d = new Date(f.datetime || f.datetime_local || f.time || Date.now());
          const day = d.toLocaleDateString("it-IT",{weekday:"short"});
          const c = this._mapWeatherEntityToCondition(f.condition || f.state || "");
          const hi = (f.temperature != null ? Math.round(Number(f.temperature)) : "—");
          const lo = (f.templow != null ? Math.round(Number(f.templow)) : (f.temperature_low != null ? Math.round(Number(f.temperature_low)) : null));
          return `
            <div class="dItem">
              <div class="dDay">${this._esc(day)}</div>
              <div class="dIcon">${this._iconSVG(c.iconKey)}</div>
              <div class="dTemp">
                <span class="hi">${hi}°</span>
                ${lo !== null ? `<span class="lo">${lo}°</span>` : ``}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    ` : ""}
  </div>
` : ""}



  <div class="footer">
    <div>WSC PRO</div>
    <div>v${WSCCard.VERSION}</div>
  </div>
</ha-card>
    `;

    // bind buttons
    const bC = this.shadowRoot.querySelector("#wscBtnCharts");
    const bD = this.shadowRoot.querySelector("#wscBtnDetails");
    if (bC) bC.onclick = this._onToggleCharts;
    if (bD) bD.onclick = this._onToggleDetails;

    // draw charts after layout
    if (this._ui.showCharts) this._scheduleDrawCharts();
  }
}

customElements.define("weather-station-card2", WSCCard);


/* ===================== Visual Editor (HA) ===================== */

class WSCEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._render();
  }

  _valueChanged(ev) {
    if (!this._config) return;
    const detail = ev.detail?.value;
    if (!detail) return;
    this._config = detail;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
  }

  _render() {
    if (!this._config) return;
    const schema = [
      { name: "nome", selector: { text: {} } },
      { name: "mostra_nome", selector: { boolean: {} } },
      { name: "mostra_orologio", selector: { boolean: {} } },
      { name: "mostra_data", selector: { boolean: {} } },

      { name: "weather_entity", selector: { entity: { domain: "weather" } } },

      { name: "forecast_days", selector: { number: { min: 3, max: 7, mode: "box" } } },
      { name: "forecast_hours", selector: { number: { min: 6, max: 48, mode: "box" } } },

      { name: "sample_interval_sec", selector: { number: { min: 10, max: 900, mode: "box" } } },
      { name: "history_hours", selector: { number: { min: 1, max: 168, mode: "box" } } },
      { name: "smoothing", selector: { number: { min: 0, max: 0.5, step: 0.01, mode: "box" } } },

      // Station sensors (optional)
      { name: "temperatura", selector: { entity: { domain: "sensor" } } },
      { name: "umidita", selector: { entity: { domain: "sensor" } } },
      { name: "velocita_vento", selector: { entity: { domain: "sensor" } } },
      { name: "raffica_vento", selector: { entity: { domain: "sensor" } } },
      { name: "direzione_vento", selector: { entity: { domain: "sensor" } } },
      { name: "tasso_pioggia", selector: { entity: { domain: "sensor" } } },
      { name: "pioggia_evento", selector: { entity: { domain: "sensor" } } },
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
    ];

    this.innerHTML = `
      <ha-form
        .data=${this._config}
        .schema=${schema}
        .computeLabel=${(s) => {
          const labels = {
            nome: "Nome",
            mostra_nome: "Mostra nome",
            mostra_orologio: "Mostra orologio",
            mostra_data: "Mostra data",
            weather_entity: "Entità meteo (OBBLIGATORIA)",
            forecast_days: "Forecast giorni",
            forecast_hours: "Forecast ore",
            sample_interval_sec: "Intervallo campionamento (s)",
            history_hours: "Storico (ore)",
            smoothing: "Smoothing grafici (0..0.5)",
          };
          return labels[s.name] || s.name;
        }}
      ></ha-form>
    `;

    const form = this.querySelector("ha-form");
    if (form) form.addEventListener("value-changed", (e) => this._valueChanged(e));
  }
}

customElements.define("wsc-editor", WSCEditor);

WSCCard.getConfigElement = () => document.createElement("wsc-editor");
WSCCard.getStubConfig = () => ({
  nome: "Stazione Meteo",
  mostra_nome: true,
  mostra_orologio: false,
  mostra_data: false,
  weather_entity: "",
  forecast_days: 5,
  forecast_hours: 24,
});
