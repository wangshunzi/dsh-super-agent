/* ==========================================================================
   AETHER · 天气
   A single-page weather experience — no dependencies, no build step.
   Data: Open-Meteo (forecast + air quality). Falls back to a local sample
   dataset when the network is unavailable so the page never looks broken.
   ========================================================================== */

(() => {
  "use strict";

  /* ---------- Small helpers ---------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, "0");
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function parseISOLocal(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso || ""));
    if (!m) {
      const d = new Date();
      return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), minutes: d.getHours() * 60 + d.getMinutes() };
    }
    const [, y, mo, d, h = "0", mi = "0"] = m;
    const hh = Number(h);
    const mm = Number(mi);
    return { y: Number(y), mo: Number(mo), d: Number(d), h: hh, mi: mm, minutes: hh * 60 + mm };
  }

  const hhmm = (iso) => String(iso || "").slice(11, 16);
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function weekdayFor(iso) {
    const t = parseISOLocal(iso);
    return WEEKDAYS[new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay()];
  }

  /* ---------- Units ---------- */

  const state = {
    unit: "c",
    place: { name: "北京", region: "中国 · 北京市", lat: 39.9042, lon: 116.4074 },
    data: null,
    aqi: null,
    demo: false,
    aqiLoading: false,
    seq: 0,
    clockBase: null,
    lastLoad: 0,
  };

  const toUnit = (celsius) => (state.unit === "f" ? (celsius * 9) / 5 + 32 : celsius);
  const unitTemp = (celsius) => Math.round(toUnit(Number(celsius) || 0));
  const fmtTemp = (celsius) => `${unitTemp(celsius)}°`;
  const unitLetter = () => (state.unit === "f" ? "F" : "C");

  /* ---------- Weather codes ---------- */

  const WMO = {
    0: { label: "晴朗", en: "Clear", group: "clear" },
    1: { label: "大致晴朗", en: "Mostly clear", group: "clear" },
    2: { label: "局部多云", en: "Partly cloudy", group: "partly" },
    3: { label: "阴天", en: "Overcast", group: "cloudy" },
    45: { label: "有雾", en: "Fog", group: "fog" },
    48: { label: "雾凇", en: "Rime fog", group: "fog" },
    51: { label: "轻微毛毛雨", en: "Light drizzle", group: "drizzle" },
    53: { label: "毛毛雨", en: "Drizzle", group: "drizzle" },
    55: { label: "较强毛毛雨", en: "Dense drizzle", group: "drizzle" },
    56: { label: "冻毛毛雨", en: "Freezing drizzle", group: "drizzle" },
    57: { label: "强冻毛毛雨", en: "Dense freezing drizzle", group: "drizzle" },
    61: { label: "小雨", en: "Light rain", group: "rain" },
    63: { label: "中雨", en: "Rain", group: "rain" },
    65: { label: "大雨", en: "Heavy rain", group: "rain" },
    66: { label: "冻雨", en: "Freezing rain", group: "rain" },
    67: { label: "强冻雨", en: "Heavy freezing rain", group: "rain" },
    71: { label: "小雪", en: "Light snow", group: "snow" },
    73: { label: "中雪", en: "Snow", group: "snow" },
    75: { label: "大雪", en: "Heavy snow", group: "snow" },
    77: { label: "米雪", en: "Snow grains", group: "snow" },
    80: { label: "阵雨", en: "Rain showers", group: "rain" },
    81: { label: "较强阵雨", en: "Rain showers", group: "rain" },
    82: { label: "暴雨", en: "Violent rain showers", group: "rain" },
    85: { label: "阵雪", en: "Snow showers", group: "snow" },
    86: { label: "强阵雪", en: "Heavy snow showers", group: "snow" },
    95: { label: "雷阵雨", en: "Thunderstorm", group: "storm" },
    96: { label: "雷阵雨伴冰雹", en: "Thunderstorm with hail", group: "storm" },
    99: { label: "强雷暴伴冰雹", en: "Severe thunderstorm with hail", group: "storm" },
  };

  const weatherInfo = (code) => WMO[code] || { label: "多云", en: "Cloudy", group: "cloudy" };

  const windDirection = (deg) => ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][Math.round((((Number(deg) || 0) % 360) + 360) % 360 / 45) % 8];

  function beaufort(kmh) {
    const speed = Number(kmh) || 0;
    const limits = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
    let level = 0;
    for (let i = 0; i < limits.length; i += 1) if (speed >= limits[i]) level = i + 1;
    return Math.min(level, 12);
  }

  function uvLevel(uv) {
    const v = Number(uv) || 0;
    if (v < 3) return "低";
    if (v < 6) return "中等";
    if (v < 8) return "高";
    if (v < 11) return "很高";
    return "极高";
  }

  function aqiLevel(aqi) {
    const v = Number(aqi);
    if (!Number.isFinite(v)) return null;
    if (v <= 50) return { label: "优", color: "#7fe3a1" };
    if (v <= 100) return { label: "良", color: "#d7ea8a" };
    if (v <= 150) return { label: "轻度污染", color: "#ffd479" };
    if (v <= 200) return { label: "中度污染", color: "#ffa96e" };
    if (v <= 300) return { label: "重度污染", color: "#ff7a8a" };
    return { label: "严重污染", color: "#d68cff" };
  }

  function humidityLabel(rh) {
    const v = Number(rh) || 0;
    if (v < 30) return "干燥";
    if (v < 45) return "清爽";
    if (v <= 65) return "舒适";
    if (v <= 80) return "微潮";
    return "潮湿";
  }

  function visibilityLabel(km) {
    if (km >= 20) return "通透 · 远方清晰";
    if (km >= 10) return "良好 · 视野开阔";
    if (km >= 4) return "一般 · 略有薄雾";
    return "较低 · 出行留意";
  }

  function pressureLabel(hpa) {
    if (hpa >= 1020) return "高压 · 天气稳定";
    if (hpa >= 1000) return "平稳 · 气压舒适";
    return "低压 · 天气多变";
  }

  /* ---------- Weather icons ---------- */

  let iconSeq = 0;

  function iconDefs(uid) {
    return `<defs>
      <radialGradient id="sunG${uid}" cx="36%" cy="30%" r="80%">
        <stop offset="0" stop-color="#fff9e3"/><stop offset=".5" stop-color="#ffe2a0"/><stop offset="1" stop-color="#ffb15a"/>
      </radialGradient>
      <linearGradient id="cloudG${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset=".58" stop-color="#e4eefc"/><stop offset="1" stop-color="#b8cae4"/>
      </linearGradient>
      <linearGradient id="cloudG2${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e8f1ff"/><stop offset="1" stop-color="#a8bddb"/>
      </linearGradient>
      <radialGradient id="moonG${uid}" cx="36%" cy="32%" r="78%">
        <stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#eef2ff"/><stop offset="1" stop-color="#bfcaeb"/>
      </radialGradient>
      <linearGradient id="boltG${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe9a6"/><stop offset="1" stop-color="#ffb03f"/>
      </linearGradient>
    </defs>`;
  }

  function sunShape(uid, cx, cy, r) {
    const rays = Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      const x1 = cx + Math.cos(a) * (r + 3.4);
      const y1 = cy + Math.sin(a) * (r + 3.4);
      const x2 = cx + Math.cos(a) * (r + 7.4);
      const y2 = cy + Math.sin(a) * (r + 7.4);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }).join("");
    return `<g class="wi-sun">
      <circle cx="${cx}" cy="${cy}" r="${r + 8}" fill="url(#sunG${uid})" opacity=".16"/>
      <g class="wi-rays" stroke="#ffd28d" stroke-width="1.8" stroke-linecap="round">${rays}</g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#sunG${uid})"/>
    </g>`;
  }

  function moonShape(uid, cx, cy, r) {
    return `<g class="wi-moon">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#moonG${uid})"/>
      <circle cx="${cx - r * 0.28}" cy="${cy - r * 0.18}" r="${r * 0.16}" fill="#aebbdd" opacity=".55"/>
      <circle cx="${cx + r * 0.3}" cy="${cy + r * 0.3}" r="${r * 0.11}" fill="#aebbdd" opacity=".45"/>
      <path d="M${cx + r + 4} ${cy - r - 2}l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z" fill="#fff" opacity=".9"/>
    </g>`;
  }

  const CLOUD_PATH = "M13.5 47c-4.8 0-8.7-3.7-8.7-8.3 0-4.5 3.9-8.2 8.7-8.2.6 0 1.2 0 1.8.1C17.9 25 23.4 20.7 29.9 20.7c7.4 0 13.4 5.6 14.1 12.7 4.3.5 7.6 3.9 7.6 8 0 4.4-3.8 8-8.4 8H13.5Z";

  function cloudShape(uid, transform = "", gradient = "cloudG", cls = "wi-cloud") {
    return `<g transform="${transform}">
      <g class="${cls}" stroke="none">
        <path d="${CLOUD_PATH}" fill="url(#${gradient}${uid})"/>
        <path d="${CLOUD_PATH}" fill="none" stroke="rgba(255,255,255,.55)" stroke-width=".8" opacity=".5"/>
      </g>
    </g>`;
  }

  function dropsShape(uid, xs, ys, heavy = false) {
    return `<g stroke="#9ed4ff" stroke-width="${heavy ? 2.6 : 2.2}" stroke-linecap="round" fill="none">
      ${xs
        .map(
          (x, i) =>
            `<line class="wi-drop" x1="${x}" y1="${ys[i]}" x2="${x - 1.6}" y2="${ys[i] + 4.5}" style="animation-delay:${(i * 0.32).toFixed(2)}s"/>`
        )
        .join("")}
    </g>`;
  }

  function flakesShape(ys) {
    return `<g fill="#eaf5ff">${ys
      .map(
        (y, i) =>
          `<g class="wi-flake" style="animation-delay:${(i * 0.7).toFixed(2)}s">
            <circle cx="${22 + i * 10}" cy="${y}" r="1.9"/>
            <path d="M${22 + i * 10} ${y - 4.2}v8.4M${18 + i * 10} ${y - 2.1}l8 4.2M${18 + i * 10} ${y + 2.1}l8-4.2" stroke="#eaf5ff" stroke-width="1" stroke-linecap="round"/>
          </g>`
      )
      .join("")}</g>`;
  }

  function weatherIcon(code, isDay = true, cls = "") {
    const info = weatherInfo(code);
    const group = info.group;
    const uid = `w${++iconSeq}`;
    const night = !isDay;
    let body = "";

    if (group === "clear") {
      body = night ? moonShape(uid, 32, 30, 12.5) : sunShape(uid, 32, 30, 12.5);
    } else if (group === "partly") {
      body =
        (night ? moonShape(uid, 41, 23, 8.2) : sunShape(uid, 41, 23, 8.6)) +
        cloudShape(uid, "translate(-3 6) scale(.94)");
    } else if (group === "cloudy") {
      body =
        cloudShape(uid, "translate(7 2) scale(.64)", "cloudG2", "wi-cloud") +
        cloudShape(uid, "translate(-2 8) scale(.94)");
    } else if (group === "fog") {
      body =
        cloudShape(uid, "translate(-1 1) scale(.9)") +
        `<g class="wi-fog" stroke="#c9d7ec" stroke-width="2.3" stroke-linecap="round" opacity=".9">
          <line x1="17" y1="51" x2="47" y2="51"/><line x1="21" y1="56.5" x2="43" y2="56.5"/><line x1="15" y1="62" x2="35" y2="62"/>
        </g>`;
    } else if (group === "drizzle") {
      body =
        cloudShape(uid, "translate(0 2) scale(.92)") +
        dropsShape(uid, [23, 39], [47, 50]) +
        dropsShape(uid, [31], [47]);
    } else if (group === "rain") {
      body = cloudShape(uid, "translate(0 1) scale(.92)") + dropsShape(uid, [19, 30, 41, 51], [46, 49, 47, 51], true);
    } else if (group === "snow") {
      body = cloudShape(uid, "translate(0 1) scale(.92)") + flakesShape([48, 53, 58]);
    } else if (group === "storm") {
      body =
        cloudShape(uid, "translate(0 0) scale(.92)") +
        `<g class="wi-bolt" stroke="none"><path d="M32 41 25.5 54h5.2L27 63l11-14h-5.8l3.2-8Z" fill="url(#boltG${uid})"/></g>`;
    }

    return `<svg class="wi ${cls}" viewBox="0 0 64 64" role="img" aria-label="${esc(info.label)}" xmlns="http://www.w3.org/2000/svg">${iconDefs(uid)}${body}</svg>`;
  }

  /* ---------- UI helpers ---------- */

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  function animateTemperature(el, celsius) {
    const target = unitTemp(celsius);
    const previous = Number(el.dataset.temp);
    el.dataset.temp = String(target);
    cancelAnimationFrame(el._tempRaf);
    if (reduceMotion || !Number.isFinite(previous) || previous === target) {
      el.textContent = String(target);
      return;
    }
    const start = performance.now();
    const duration = 850;
    const step = (now) => {
      const t = clamp((now - start) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(previous + (target - previous) * eased));
      if (t < 1) el._tempRaf = requestAnimationFrame(step);
    };
    el._tempRaf = requestAnimationFrame(step);
  }

  function currentMinutes() {
    if (!state.clockBase) return new Date().getHours() * 60 + new Date().getMinutes();
    const elapsed = Math.floor((Date.now() - state.clockBase.ts) / 60000);
    return (state.clockBase.minutes + elapsed + 1440) % 1440;
  }

  function updateClock() {
    if (!state.data) return;
    const cur = state.data.current;
    const total = currentMinutes();
    const dayOffset = state.clockBase ? Math.floor((state.clockBase.minutes + Math.floor((Date.now() - state.clockBase.ts) / 60000)) / 1440) : 0;
    const base = parseISOLocal(cur.time);
    let y = base.y;
    let mo = base.mo;
    let d = base.d + dayOffset;
    if (d > 28) {
      const probe = new Date(Date.UTC(y, mo - 1, d));
      y = probe.getUTCFullYear();
      mo = probe.getUTCMonth() + 1;
      d = probe.getUTCDate();
    }
    const label = `${mo}月${d}日 · ${WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]}`;
    setText("localTime", `${label} · ${pad(Math.floor(total / 60))}:${pad(total % 60)}`);
  }

  /* ---------- Theme ---------- */

  function applyTheme(data) {
    const cur = data.current;
    const info = weatherInfo(cur.weather_code);
    const minutes = currentMinutes();
    const rise = parseISOLocal(data.daily.sunrise[0]).minutes;
    const set = parseISOLocal(data.daily.sunset[0]).minutes;

    let phase = cur.is_day ? "day" : "night";
    if (minutes >= rise - 40 && minutes < rise + 50) phase = "dawn";
    else if (minutes >= set - 50 && minutes < set + 35) phase = "dusk";
    else if (minutes >= rise + 50 && minutes < set - 50) phase = "day";

    const body = document.body;
    body.dataset.theme = phase;
    body.dataset.wx = info.group;

    const cover = clamp(Number(cur.cloud_cover) || 0, 0, 100);
    const cloudStrength = 0.14 + (cover / 100) * 0.86;
    body.style.setProperty("--cloud", cloudStrength.toFixed(3));
    body.style.setProperty("--orb-cloud", clamp(0.16 + (cover / 100) * 0.84, 0.16, 1).toFixed(3));
    refreshSky();
  }

  /* ---------- Hero ---------- */

  function renderHero(data) {
    const cur = data.current;
    const daily = data.daily;
    const info = weatherInfo(cur.weather_code);
    const place = state.place;

    setText("placeName", place.name);
    setText("placeRegion", place.region);
    setText("unitLetter", unitLetter());
    setText("conditionText", info.label);
    setText("feelsText", `体感 ${fmtTemp(cur.apparent_temperature)}`);
    setText("highLowText", `最高 ${fmtTemp(daily.temperature_2m_max[0])} · 最低 ${fmtTemp(daily.temperature_2m_min[0])}`);
    setText("updatedText", `更新于 ${hhmm(cur.time)}${state.demo ? " · 示例数据" : ""}`);
    setText("statWind", `${windDirection(cur.wind_direction_10m)}风 ${beaufort(cur.wind_speed_10m)}级`);
    setText("statHumidity", `湿度 ${Math.round(Number(cur.relative_humidity_2m) || 0)}%`);
    setText("statCloud", `云量 ${Math.round(Number(cur.cloud_cover) || 0)}%`);

    const lat = Number(data.latitude ?? place.lat);
    const lon = Number(data.longitude ?? place.lon);
    setText("coordText", `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`);
    setText("hourlyNote", `此刻 ${hhmm(cur.time)}`);
    setText("dailyNote", place.name);
    setText("detailsNote", `更新于 ${hhmm(cur.time)}`);
    setText("footerUpdate", `${data.timezone || "本地"} · 每 10 分钟自动更新`);

    animateTemperature($("#tempNow"), cur.temperature_2m);
    setText("liveStatus", `${place.name}，${info.label}，${unitTemp(cur.temperature_2m)} 度，体感 ${unitTemp(cur.apparent_temperature)} 度`);
    updateClock();
    renderOrb(data);
  }

  function renderOrb(data) {
    const orb = $("#orb");
    if (!orb) return;
    const minutes = currentMinutes();
    const cur = data.current;
    const rise = parseISOLocal(data.daily.sunrise[0]).minutes;
    const set = parseISOLocal(data.daily.sunset[0]).minutes;
    const isDaytime = minutes >= rise && minutes < set;

    let progress;
    if (isDaytime) {
      progress = (minutes - rise) / Math.max(1, set - rise);
    } else {
      const nightLength = (rise + 1440 - set) % 1440 || 720;
      progress = ((minutes - set + 1440) % 1440) / nightLength;
    }
    progress = clamp(progress, 0, 1);
    const x = 14 + progress * 72;
    const y = 72 - Math.sin(Math.PI * progress) * 50;
    orb.style.setProperty("--cx", `${x.toFixed(2)}%`);
    orb.style.setProperty("--cy", `${y.toFixed(2)}%`);
    const cover = clamp(Number(cur.cloud_cover) || 0, 0, 100);
    orb.style.setProperty("--celestial-alpha", (1 - cover / 135).toFixed(2));

    let sunInfo;
    if (minutes < rise) sunInfo = `日出 ${hhmm(data.daily.sunrise[0])}`;
    else if (minutes >= set) sunInfo = `日出 ${hhmm(data.daily.sunrise[1] || data.daily.sunrise[0])}`;
    else sunInfo = `日落 ${hhmm(data.daily.sunset[0])}`;
    setText("orbSunInfo", sunInfo);

    const stars = $("#orbStars");
    if (stars && !stars.childElementCount) {
      let html = "";
      for (let i = 0; i < 42; i += 1) {
        const size = (Math.random() * 1.5 + 0.5).toFixed(2);
        const top = (Math.random() * 62 + 4).toFixed(2);
        const left = (Math.random() * 94 + 3).toFixed(2);
        const delay = (Math.random() * 4).toFixed(2);
        const dur = (Math.random() * 3 + 3).toFixed(2);
        html += `<span style="width:${size}px;height:${size}px;top:${top}%;left:${left}%;--tw:${dur}s;--tw-delay:${delay}s"></span>`;
      }
      stars.innerHTML = html;
    }

    const precip = $("#orbPrecip");
    if (precip) {
      const info = weatherInfo(cur.weather_code);
      let html = "";
      if (info.group === "rain" || info.group === "drizzle" || info.group === "storm") {
        const count = info.group === "storm" ? 16 : info.group === "rain" ? 13 : 7;
        for (let i = 0; i < count; i += 1) {
          html += `<span class="orb-drop" style="left:${(8 + Math.random() * 84).toFixed(1)}%;--dur:${(0.8 + Math.random() * 0.7).toFixed(2)}s;--delay:${(Math.random() * 1.4).toFixed(2)}s"></span>`;
        }
      } else if (info.group === "snow") {
        for (let i = 0; i < 16; i += 1) {
          const size = (2 + Math.random() * 2).toFixed(1);
          html += `<span class="orb-flake" style="left:${(6 + Math.random() * 88).toFixed(1)}%;width:${size}px;height:${size}px;--dur:${(5 + Math.random() * 4).toFixed(1)}s;--delay:${(Math.random() * 4).toFixed(1)}s"></span>`;
        }
      }
      precip.innerHTML = html;
    }
  }

  /* ---------- Hourly ---------- */

  function renderHourly(data) {
    const list = $("#hourlyList");
    if (!list) return;
    const hours = data.hourly;
    const current = data.current.time;
    let start = hours.time.findIndex((t) => t >= current);
    if (start < 0) start = 0;

    const items = [];
    for (let i = start; i < Math.min(start + 24, hours.time.length); i += 1) {
      const isNow = i === start;
      const precipChance = Number(hours.precipitation_probability?.[i]) || 0;
      const title = `${hhmm(hours.time[i])} · ${weatherInfo(hours.weather_code[i]).label} · ${fmtTemp(hours.temperature_2m[i])} · 降水 ${Math.round(precipChance)}%`;
      const rain =
        precipChance >= 10
          ? `<span class="h-rain"><svg aria-hidden="true"><use href="#i-drop"/></svg>${Math.round(precipChance)}%</span>`
          : `<span class="h-rain empty" aria-hidden="true">—</span>`;
      items.push(`<div class="hour${isNow ? " now" : ""}" role="listitem" title="${esc(title)}">
        <span class="h-time">${isNow ? "现在" : hhmm(hours.time[i])}</span>
        <span class="h-icon">${weatherIcon(hours.weather_code[i], hours.is_day?.[i] !== 0, isNow ? "wi-current" : "")}</span>
        <span class="h-temp">${fmtTemp(hours.temperature_2m[i])}</span>
        ${rain}
      </div>`);
    }
    list.innerHTML = items.join("");
  }

  /* ---------- Weekly ---------- */

  function renderWeekly(data) {
    const list = $("#weekList");
    if (!list) return;
    const daily = data.daily;
    const weekMin = Math.min(...daily.temperature_2m_min);
    const weekMax = Math.max(...daily.temperature_2m_max);
    const span = Math.max(0.5, weekMax - weekMin);
    const rows = [];

    for (let i = 0; i < daily.time.length; i += 1) {
      const info = weatherInfo(daily.weather_code[i]);
      const min = Number(daily.temperature_2m_min[i]);
      const max = Number(daily.temperature_2m_max[i]);
      const left = clamp(((min - weekMin) / span) * 100, 0, 100);
      const width = clamp(((max - min) / span) * 100, 5, 100 - left);
      const rainChance = Math.round(Number(daily.precipitation_probability_max?.[i]) || 0);
      const date = parseISOLocal(daily.time[i]);
      const dayName = i === 0 ? "今天" : i === 1 ? "明天" : weekdayFor(daily.time[i]);
      const marker =
        i === 0
          ? `<span class="range-dot" style="left:${clamp(((Number(data.current.temperature_2m) - weekMin) / span) * 100, 0, 100).toFixed(1)}%"></span>`
          : "";
      rows.push(`<div class="day-row${i === 0 ? " today" : ""}" role="listitem" title="${esc(`${dayName} · ${info.label} · ${fmtTemp(min)} ~ ${fmtTemp(max)}`)}">
        <div class="day-name"><strong>${dayName}</strong><span>${pad(date.mo)}/${pad(date.d)}</span></div>
        <div class="day-cond">
          <span class="day-icon">${weatherIcon(daily.weather_code[i], true)}</span>
          <span class="cond-name">${esc(info.label)}</span>
        </div>
        <div class="day-rain${rainChance < 5 ? " empty" : ""}">
          <svg aria-hidden="true"><use href="#i-drop"/></svg>${rainChance < 5 ? "—" : `${rainChance}%`}
        </div>
        <div class="day-temp">
          <span class="t-min">${fmtTemp(min)}</span>
          <span class="range"><span class="range-fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span>${marker}</span>
          <span class="t-max">${fmtTemp(max)}</span>
        </div>
      </div>`);
    }
    list.innerHTML = rows.join("");
  }

  /* ---------- Details ---------- */

  function renderSun(data) {
    const minutes = currentMinutes();
    const rise = parseISOLocal(data.daily.sunrise[0]).minutes;
    const set = parseISOLocal(data.daily.sunset[0]).minutes;
    const progress = clamp((minutes - rise) / Math.max(1, set - rise), 0, 1);
    const inv = 1 - progress;
    const x = inv * inv * 30 + 2 * inv * progress * 600 + progress * progress * 1170;
    const y = inv * inv * 132 + 2 * inv * progress * -72 + progress * progress * 132;
    const dot = $("#sunDot");
    const halo = $("#sunDotHalo");
    const ring = $("#sunDotRing");
    const stem = $("#sunStem");
    if (dot) {
      dot.setAttribute("cx", x.toFixed(1));
      dot.setAttribute("cy", y.toFixed(1));
    }
    if (halo) {
      halo.setAttribute("cx", x.toFixed(1));
      halo.setAttribute("cy", y.toFixed(1));
    }
    if (ring) {
      ring.setAttribute("cx", x.toFixed(1));
      ring.setAttribute("cy", y.toFixed(1));
    }
    if (stem) {
      stem.setAttribute("x1", x.toFixed(1));
      stem.setAttribute("x2", x.toFixed(1));
      stem.setAttribute("y1", y.toFixed(1));
      stem.setAttribute("y2", "132");
    }

    const daylight = Number(data.daily.daylight_duration?.[0]) || (set - rise) * 60;
    const dh = Math.floor(daylight / 3600);
    const dm = Math.round((daylight % 3600) / 60);
    setText("dayLength", `白昼 ${dh} 小时 ${dm} 分`);
    setText("sunriseTime", hhmm(data.daily.sunrise[0]));
    setText("sunsetTime", hhmm(data.daily.sunset[0]));

    let stateText;
    if (minutes < rise) {
      const diff = rise - minutes;
      stateText = `距离日出 ${Math.floor(diff / 60) ? `${Math.floor(diff / 60)} 小时 ` : ""}${diff % 60} 分`;
    } else if (minutes >= set) {
      const tomorrowRise = parseISOLocal(data.daily.sunrise[1] || data.daily.sunrise[0]);
      const diff = 1440 - minutes + tomorrowRise.minutes;
      stateText = `夜色 · 距日出 ${Math.floor(diff / 60)} 小时 ${diff % 60} 分`;
    } else {
      const diff = set - minutes;
      stateText = `白昼 · 距日落 ${Math.floor(diff / 60)} 小时 ${diff % 60} 分`;
    }
    setText("sunState", stateText);
  }

  function renderAqi() {
    const cat = aqiLevel(state.aqi?.us_aqi);
    const valueEl = $("#aqiValue");
    const unitEl = $("#aqiUnit");
    const subEl = $("#aqiSub");
    const dot = $("#aqiDot");
    if (!cat) {
      if (valueEl) valueEl.textContent = "—";
      if (unitEl) unitEl.textContent = "";
      if (subEl) subEl.textContent = state.aqiLoading ? "正在获取 AQI…" : "暂无数据";
      if (dot) dot.style.setProperty("--aqi-color", "rgba(255,255,255,.25)");
      return;
    }
    if (valueEl) valueEl.textContent = String(Math.round(Number(state.aqi.us_aqi)));
    if (unitEl) unitEl.textContent = "AQI";
    const pm = state.aqi.pm2_5;
    if (subEl) subEl.textContent = `${cat.label}${Number.isFinite(Number(pm)) ? ` · PM2.5 ${Math.round(Number(pm))} μg/m³` : ""}`;
    if (dot) dot.style.setProperty("--aqi-color", cat.color);
  }

  function renderDetails(data) {
    const cur = data.current;
    const daily = data.daily;

    setText("humidityValue", String(Math.round(Number(cur.relative_humidity_2m) || 0)));
    setText("humiditySub", `露点 ${fmtTemp(cur.dew_point_2m)} · ${humidityLabel(cur.relative_humidity_2m)}`);

    setText("windValue", String(Math.round(Number(cur.wind_speed_10m) || 0)));
    setText("windSub", `${windDirection(cur.wind_direction_10m)}风 · 阵风 ${Math.round(Number(cur.wind_gusts_10m) || 0)} km/h`);
    const arrow = $("#windArrow");
    if (arrow) arrow.style.setProperty("--wind-rot", `${Math.round(Number(cur.wind_direction_10m) || 0)}deg`);

    const pressure = Number(cur.pressure_msl) || 0;
    setText("pressureValue", String(Math.round(pressure)));
    setText("pressureSub", pressureLabel(pressure));

    const visMeters = Number(cur.visibility);
    const visKm = Number.isFinite(visMeters) ? visMeters / 1000 : 0;
    setText("visibilityValue", visKm >= 10 ? String(Math.round(visKm)) : visKm.toFixed(1));
    setText("visibilitySub", visibilityLabel(visKm));

    const uv = Number(cur.uv_index ?? daily.uv_index_max?.[0]) || 0;
    setText("uvValue", String(Math.round(uv)));
    setText("uvSub", `${uvLevel(uv)} · 今日峰值 ${Math.round(Number(daily.uv_index_max?.[0]) || uv)}`);
    const marker = $("#uvMarker");
    if (marker) marker.style.setProperty("--uv", `${clamp((uv / 11) * 100, 2, 100).toFixed(1)}%`);

    renderSun(data);
    renderAqi();
  }

  /* ---------- Demo / fallback dataset ---------- */

  function buildDemoData() {
    const now = new Date();
    const month = now.getMonth();
    const seasonal = [2, 4, 10, 17, 22, 26, 29, 28, 23, 16, 9, 3][month];
    const startHour = now.getHours();
    const baseTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startHour, 0, 0);

    const isoLocal = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const roundQuarter = (date) => {
      const d = new Date(date);
      d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
      return d;
    };

    const codes = [0, 1, 0, 2, 2, 3, 1, 0, 0, 2, 3, 61, 3, 2, 1, 0];
    const hourly = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], weather_code: [], is_day: [], uv_index: [], wind_speed_10m: [], relative_humidity_2m: [], visibility: [] };
    for (let i = 0; i < 48; i += 1) {
      const t = new Date(baseTime.getTime() + i * 3600000);
      const hour = t.getHours();
      const temp = seasonal + 4.5 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + (i > 24 ? -0.8 : 0);
      const code = codes[(Math.floor(i / 3) + 2) % codes.length];
      hourly.time.push(isoLocal(t));
      hourly.temperature_2m.push(Number(temp.toFixed(1)));
      hourly.apparent_temperature.push(Number((temp - 1.6).toFixed(1)));
      hourly.precipitation_probability.push(code >= 61 ? 55 : code === 3 ? 18 : code === 2 ? 8 : 0);
      hourly.weather_code.push(code);
      hourly.is_day.push(hour >= 6 && hour < 18 ? 1 : 0);
      hourly.uv_index.push(hour >= 8 && hour <= 16 ? Math.max(0, 3.4 - Math.abs(12 - hour) * 0.55) : 0);
      hourly.wind_speed_10m.push(Number((7 + Math.sin(i / 5) * 3 + (code >= 61 ? 6 : 0)).toFixed(1)));
      hourly.relative_humidity_2m.push(Math.round(clamp(58 - temp * 1.1, 32, 88)));
      hourly.visibility.push(code >= 61 ? 9000 : 20000);
    }

    const sunrise = "06:52";
    const sunset = "17:04";
    const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], sunrise: [], sunset: [], uv_index_max: [], precipitation_probability_max: [], wind_speed_10m_max: [], daylight_duration: [] };
    for (let i = 0; i < 7; i += 1) {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const code = codes[(i + 1) % codes.length];
      const hi = seasonal + 2.6 + (i % 2) * 1.2;
      const lo = seasonal - 4.3 + (i % 3) * 0.6;
      daily.time.push(isoLocal(t).slice(0, 10));
      daily.weather_code.push(code);
      daily.temperature_2m_max.push(Number(hi.toFixed(1)));
      daily.temperature_2m_min.push(Number(lo.toFixed(1)));
      daily.sunrise.push(`${isoLocal(t).slice(0, 10)}T${sunrise}`);
      daily.sunset.push(`${isoLocal(t).slice(0, 10)}T${sunset}`);
      daily.uv_index_max.push(3.2);
      daily.precipitation_probability_max.push(code >= 61 ? 55 : code === 3 ? 18 : 0);
      daily.wind_speed_10m_max.push(11.2);
      daily.daylight_duration.push(36720);
    }

    const hour = now.getHours();
    const temp = seasonal + 4.5 * Math.sin(((hour - 9) / 24) * Math.PI * 2);
    const nowTime = roundQuarter(now);

    return {
      latitude: state.place.lat,
      longitude: state.place.lon,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      current: {
        time: isoLocal(nowTime),
        temperature_2m: Number(temp.toFixed(1)),
        relative_humidity_2m: Math.round(clamp(58 - temp * 1.1, 32, 88)),
        apparent_temperature: Number((temp - 1.6).toFixed(1)),
        is_day: hour >= 6 && hour < 18 ? 1 : 0,
        precipitation: 0,
        weather_code: codes[(hour + 2) % codes.length],
        cloud_cover: 22,
        pressure_msl: 1018.4,
        wind_speed_10m: 9.4,
        wind_direction_10m: 214,
        wind_gusts_10m: 16.8,
        dew_point_2m: Number((temp - 7).toFixed(1)),
        visibility: 20000,
        uv_index: Math.max(0, 3.2 - Math.abs(12 - hour) * 0.5),
      },
      hourly,
      daily,
    };
  }

  /* ---------- Data loading ---------- */

  const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
  const AQI_API = "https://air-quality-api.open-meteo.com/v1/air-quality";
  let weatherAbort = null;
  let aqiAbort = null;
  let lastRequestKey = "";

  function placeKey(place) {
    return `${Number(place.lat).toFixed(3)},${Number(place.lon).toFixed(3)}`;
  }

  async function loadWeather(place, { silent = false } = {}) {
    const seq = ++state.seq;
    const key = placeKey(place);
    const placeChanged = key !== lastRequestKey;
    lastRequestKey = key;

    if (weatherAbort) weatherAbort.abort();
    weatherAbort = new AbortController();
    const timeout = setTimeout(() => weatherAbort.abort(), 15000);
    if (!silent) setLoading(true);
    setButtonsBusy(true);

    const params = new URLSearchParams({
      latitude: Number(place.lat).toFixed(4),
      longitude: Number(place.lon).toFixed(4),
      current:
        "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,dew_point_2m,visibility,uv_index",
      hourly:
        "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,relative_humidity_2m,visibility,uv_index,is_day,dew_point_2m",
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,wind_speed_10m_max,daylight_duration",
      timezone: "auto",
      forecast_days: "7",
      wind_speed_unit: "kmh",
    });

    try {
      const response = await fetch(`${FORECAST_API}?${params.toString()}`, { signal: weatherAbort.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (seq !== state.seq) return;

      state.data = data;
      state.demo = false;
      state.aqi = null;
      state.aqiLoading = true;
      state.place = place;
      state.clockBase = { minutes: parseISOLocal(data.current.time).minutes, ts: Date.now() };
      state.lastLoad = Date.now();
      hideNotice();
      renderAqi();
      render();
      loadAqi(place, seq);
    } catch (error) {
      if (seq !== state.seq) return;
      const hadSamePlace = !placeChanged && state.data && !state.demo;
      if (!hadSamePlace) {
        state.data = buildDemoData(place);
        state.demo = true;
        state.aqi = null;
        state.aqiLoading = false;
        state.clockBase = { minutes: parseISOLocal(state.data.current.time).minutes, ts: Date.now() };
        state.place = place;
        render();
      }
      state.lastLoad = Date.now();
      showNotice(
        hadSamePlace
          ? "天气更新失败，正在显示上一次的数据。"
          : "天气服务暂时不可用，正在展示示例数据。"
      );
    } finally {
      clearTimeout(timeout);
      if (seq === state.seq) {
        setLoading(false);
        setButtonsBusy(false);
      }
    }
  }

  async function loadAqi(place, seq) {
    state.aqiLoading = true;
    if (aqiAbort) aqiAbort.abort();
    aqiAbort = new AbortController();
    const timeout = setTimeout(() => aqiAbort.abort(), 12000);
    try {
      const params = new URLSearchParams({
        latitude: Number(place.lat).toFixed(4),
        longitude: Number(place.lon).toFixed(4),
        current: "us_aqi,pm2_5",
        timezone: "auto",
      });
      const response = await fetch(`${AQI_API}?${params.toString()}`, { signal: aqiAbort.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (seq !== state.seq) return;
      state.aqi = data.current || null;
    } catch {
      if (seq !== state.seq) return;
      state.aqi = null;
    } finally {
      clearTimeout(timeout);
      if (seq === state.seq) {
        state.aqiLoading = false;
        renderAqi();
      }
    }
  }

  function render() {
    if (!state.data) return;
    applyTheme(state.data);
    renderHero(state.data);
    renderHourly(state.data);
    renderWeekly(state.data);
    renderDetails(state.data);
    setSkyWeather(state.data.current.weather_code);
    updateClock();
  }

  /* ---------- Loading UI ---------- */

  const progress = $("#progress");
  let progressTimer = null;

  function setLoading(active) {
    if (!progress) return;
    clearTimeout(progressTimer);
    progress.classList.remove("done");
    if (active) {
      progress.classList.remove("active");
      progress.getBoundingClientRect();
      progress.classList.add("active");
    } else {
      progress.classList.remove("active");
      progress.classList.add("done");
      progressTimer = setTimeout(() => {
        progress.classList.remove("done");
      }, 800);
    }
    document.body.dataset.loading = active ? "true" : "false";
  }

  function setButtonsBusy(active) {
    $("#refreshBtn")?.classList.toggle("spinning", active);
    $("#locateBtn")?.classList.toggle("spinning", active);
  }

  /* ---------- Notice ---------- */

  const notice = $("#notice");
  const noticeText = $("#noticeText");

  function showNotice(message) {
    if (!notice) return;
    if (noticeText) noticeText.textContent = message;
    notice.hidden = false;
  }

  function hideNotice() {
    if (notice) notice.hidden = true;
  }

  $("#noticeRetry")?.addEventListener("click", () => {
    hideNotice();
    loadWeather(state.place);
  });

  $("#noticeClose")?.addEventListener("click", hideNotice);

  /* ---------- Search ---------- */

  const search = $(".search");
  const searchInput = $("#cityInput");
  const searchResults = $("#searchResults");
  const locateBtn = $("#locateBtn");
  let searchTimer = null;
  let searchAbort = null;
  let currentResults = [];
  let activeResult = -1;

  function openResults() {
    if (!searchResults) return;
    searchResults.hidden = false;
    searchInput?.setAttribute("aria-expanded", "true");
  }

  function closeResults() {
    if (!searchResults) return;
    searchResults.hidden = true;
    searchInput?.setAttribute("aria-expanded", "false");
    searchInput?.removeAttribute("aria-activedescendant");
    activeResult = -1;
  }

  function regionFor(result) {
    const parts = [];
    if (result.country) parts.push(result.country);
    if (result.admin1 && result.admin1 !== result.name) parts.push(result.admin1);
    return parts.join(" · ") || "已选择的位置";
  }

  function renderSearchResults(results) {
    currentResults = results;
    activeResult = -1;
    if (!results.length) {
      searchResults.innerHTML = `<div class="result-empty">没有找到匹配的城市，试试其他写法。</div>`;
      openResults();
      return;
    }
    searchResults.innerHTML = results
      .map(
        (r, i) => `<button type="button" class="result" role="option" data-index="${i}" id="city-option-${i}" aria-selected="false">
          <span class="result-main"><span class="result-name">${esc(r.name)}</span><span class="result-meta">${esc(regionFor(r))}</span></span>
          <svg class="result-chevron" aria-hidden="true"><use href="#i-chevron"/></svg>
        </button>`
      )
      .join("");
    openResults();
  }

  function highlightResult(index) {
    const options = $$(".result", searchResults);
    if (!options.length) return;
    activeResult = (index + options.length) % options.length;
    options.forEach((el, i) => {
      el.classList.toggle("active", i === activeResult);
      el.setAttribute("aria-selected", i === activeResult ? "true" : "false");
    });
    searchInput?.setAttribute("aria-activedescendant", `city-option-${activeResult}`);
  }

  function chooseResult(index) {
    const result = currentResults[index];
    if (!result) return;
    const place = {
      name: result.name,
      region: regionFor(result),
      lat: result.latitude,
      lon: result.longitude,
    };
    searchInput.value = "";
    closeResults();
    searchInput.blur();
    savePlace(place);
    loadWeather(place);
  }

  async function runSearch(query) {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    const timeout = setTimeout(() => searchAbort.abort(), 10000);
    try {
      const params = new URLSearchParams({ name: query, count: "6", language: "zh", format: "json" });
      const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`, {
        signal: searchAbort.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (searchInput.value.trim() !== query) return;
      renderSearchResults(Array.isArray(data.results) ? data.results.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) : []);
    } catch {
      if (searchInput.value.trim() === query) {
        renderSearchResults([]);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  searchInput?.addEventListener("input", () => {
    const query = searchInput.value.trim();
    clearTimeout(searchTimer);
    closeResults();
    currentResults = [];
    if (searchResults) searchResults.innerHTML = "";
    if (!query) return;
    searchTimer = setTimeout(() => runSearch(query), 280);
  });

  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (searchResults.hidden) {
        if (currentResults.length) openResults();
        return;
      }
      highlightResult(activeResult + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightResult(activeResult - 1);
    } else if (event.key === "Enter") {
      if (!searchResults.hidden) {
        event.preventDefault();
        chooseResult(activeResult >= 0 ? activeResult : 0);
      }
    } else if (event.key === "Escape") {
      closeResults();
    }
  });

  searchInput?.addEventListener("focus", () => {
    if (currentResults.length) openResults();
  });

  searchResults?.addEventListener("click", (event) => {
    const button = event.target.closest(".result");
    if (!button) return;
    chooseResult(Number(button.dataset.index));
  });

  searchResults?.addEventListener("mousemove", (event) => {
    const button = event.target.closest(".result");
    if (!button) return;
    const index = Number(button.dataset.index);
    if (Number.isFinite(index) && index !== activeResult) highlightResult(index);
  });

  document.addEventListener("pointerdown", (event) => {
    if (search && !search.contains(event.target)) closeResults();
  });

  /* ---------- Location & unit controls ---------- */

  locateBtn?.addEventListener("click", () => {
    if (!navigator.geolocation) {
      showNotice("当前浏览器不支持定位，试试直接搜索城市。");
      return;
    }
    locateBtn.classList.add("spinning");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        locateBtn.classList.remove("spinning");
        const place = {
          name: "我的位置",
          region: "浏览器定位",
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        savePlace(place);
        loadWeather(place);
      },
      () => {
        locateBtn.classList.remove("spinning");
        showNotice("无法获取位置，请检查浏览器的定位权限。");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  });

  $$(".unit-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      const unit = button.dataset.unit;
      if (!unit || unit === state.unit) return;
      state.unit = unit;
      $$(".unit-toggle button").forEach((b) => b.setAttribute("aria-pressed", b === button ? "true" : "false"));
      saveUnit();
      if (state.data) render();
      renderAqi();
    });
  });

  $("#refreshBtn")?.addEventListener("click", () => {
    if (state.data) loadWeather(state.place);
  });

  /* ---------- Persistence ---------- */

  function savePlace(place) {
    try {
      localStorage.setItem("aether:place", JSON.stringify(place));
    } catch {
      /* private mode */
    }
  }

  function saveUnit() {
    try {
      localStorage.setItem("aether:unit", state.unit);
    } catch {
      /* private mode */
    }
  }

  function restore() {
    try {
      const unit = localStorage.getItem("aether:unit");
      if (unit === "f" || unit === "c") state.unit = unit;
      const raw = localStorage.getItem("aether:place");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Number.isFinite(Number(parsed.lat)) && Number.isFinite(Number(parsed.lon)) && parsed.name) {
          state.place = {
            name: String(parsed.name),
            region: String(parsed.region || "已选择的位置"),
            lat: Number(parsed.lat),
            lon: Number(parsed.lon),
          };
        }
      }
    } catch {
      /* ignore malformed storage */
    }
    $$(".unit-toggle button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.unit === state.unit ? "true" : "false"));
  }

  /* ---------- Ambient canvas (stars / rain / snow) ---------- */

  const canvas = $("#atmosphere");
  const ctx = canvas?.getContext("2d");
  const sky = {
    w: 0,
    h: 0,
    dpr: 1,
    stars: [],
    rain: [],
    snow: [],
    mode: "clear",
    last: 0,
    raf: 0,
  };

  function resizeSky() {
    if (!canvas || !ctx) return;
    sky.dpr = Math.min(window.devicePixelRatio || 1, 2);
    sky.w = window.innerWidth;
    sky.h = window.innerHeight;
    canvas.width = Math.floor(sky.w * sky.dpr);
    canvas.height = Math.floor(sky.h * sky.dpr);
    canvas.style.width = `${sky.w}px`;
    canvas.style.height = `${sky.h}px`;
    ctx.setTransform(sky.dpr, 0, 0, sky.dpr, 0, 0);
    seedStars();
    sky.last = 0;
    if (sky.raf) {
      cancelAnimationFrame(sky.raf);
      sky.raf = 0;
    }
    drawSky(performance.now(), true);
    startSkyLoop();
  }

  function seedStars() {
    const area = sky.w * sky.h;
    const count = clamp(Math.round(area / 14000), 50, 150);
    sky.stars = Array.from({ length: count }, () => ({
      x: Math.random() * sky.w,
      y: Math.random() * sky.h * 0.78,
      r: Math.random() * 1.1 + 0.3,
      a: Math.random() * 0.6 + 0.25,
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.9 + 0.3,
    }));
  }

  function seedRain(count) {
    sky.rain = Array.from({ length: count }, () => ({
      x: Math.random() * sky.w,
      y: Math.random() * sky.h,
      len: Math.random() * 14 + 8,
      speed: Math.random() * 320 + 300,
      alpha: Math.random() * 0.22 + 0.12,
      drift: Math.random() * 1.6 + 0.5,
    }));
  }

  function refreshSky() {
    if (!ctx) return;
    if (reduceMotion || !sky.raf) drawSky(performance.now(), true);
  }

  function startSkyLoop() {
    if (!ctx || reduceMotion) return;
    if (sky.raf) cancelAnimationFrame(sky.raf);
    const loop = (now) => {
      drawSky(now, false);
      sky.raf = requestAnimationFrame(loop);
    };
    sky.raf = requestAnimationFrame(loop);
  }

  function seedSnow(count) {
    sky.snow = Array.from({ length: count }, () => ({
      x: Math.random() * sky.w,
      y: Math.random() * sky.h,
      r: Math.random() * 1.8 + 0.8,
      speed: Math.random() * 45 + 25,
      sway: Math.random() * Math.PI * 2,
      swayAmp: Math.random() * 0.8 + 0.3,
      alpha: Math.random() * 0.45 + 0.3,
    }));
  }

  function setSkyWeather(code) {
    if (!ctx) return;
    const info = weatherInfo(code);
    const group = info.group;
    let mode = "clear";
    if (group === "rain" || group === "drizzle" || group === "storm") mode = "rain";
    else if (group === "snow") mode = "snow";

    if (mode !== sky.mode) {
      sky.mode = mode;
      if (mode === "rain") {
        const intensity = group === "storm" ? 170 : group === "rain" ? 130 : 55;
        seedRain(intensity);
      } else {
        sky.rain = [];
      }
      if (mode === "snow") seedSnow(120);
      else sky.snow = [];
    }
    refreshSky();
  }

  function starAlpha() {
    const theme = document.body.dataset.theme;
    if (theme === "night") return 1;
    if (theme === "dusk") return 0.55;
    if (theme === "dawn") return 0.18;
    return 0;
  }

  function drawSky(now, force = false) {
    if (!ctx) return;
    const t = now / 1000;
    const dt = sky.last ? Math.min(0.05, (now - sky.last) / 1000) : 0;
    sky.last = now;

    ctx.clearRect(0, 0, sky.w, sky.h);

    const sAlpha = starAlpha();
    if (sAlpha > 0.01) {
      for (const star of sky.stars) {
        const twinkle = 0.6 + 0.4 * Math.sin(t * star.speed + star.phase);
        ctx.globalAlpha = star.a * twinkle * sAlpha;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (sky.mode === "rain") {
      ctx.strokeStyle = "rgba(174, 210, 255, 0.9)";
      ctx.lineWidth = 1;
      for (const drop of sky.rain) {
        if (!force) {
          drop.y += drop.speed * dt;
          drop.x -= drop.drift * 60 * dt;
          if (drop.y > sky.h + 20) {
            drop.y = -20;
            drop.x = Math.random() * sky.w;
          }
          if (drop.x < -20) drop.x = sky.w + 20;
        }
        ctx.globalAlpha = drop.alpha;
        ctx.beginPath();
        ctx.moveTo(drop.x, drop.y);
        ctx.lineTo(drop.x - drop.drift * drop.len * 0.32, drop.y + drop.len);
        ctx.stroke();
      }
    }

    if (sky.mode === "snow") {
      ctx.fillStyle = "#ffffff";
      for (const flake of sky.snow) {
        if (!force) {
          flake.y += flake.speed * dt;
          flake.sway += dt * 0.8;
          flake.x += Math.sin(flake.sway) * flake.swayAmp;
          if (flake.y > sky.h + 10) {
            flake.y = -10;
            flake.x = Math.random() * sky.w;
          }
        }
        ctx.globalAlpha = flake.alpha;
        ctx.beginPath();
        ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
  }

  /* ---------- Reveal & scroll ---------- */

  function setupReveal() {
    const items = $$(".reveal");
    if (!("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add("is-in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.04 }
    );
    items.forEach((el) => observer.observe(el));
  }

  function setupScrollHeader() {
    const header = $("#siteHeader");
    if (!header) return;
    const update = () => header.classList.toggle("scrolled", window.scrollY > 18);
    update();
    window.addEventListener("scroll", update, { passive: true });
  }

  /* ---------- Init ---------- */

  function init() {
    restore();
    if (searchInput) searchInput.value = "";
    const initial = $("#tempNow");
    if (initial && !initial.dataset.temp) {
      initial.dataset.temp = "0";
      initial.textContent = "0";
    }
    setupReveal();
    setupScrollHeader();
    resizeSky();
    window.addEventListener("resize", debounce(resizeSky, 180), { passive: true });
    loadWeather(state.place);

    setInterval(updateClock, 15000);
    setInterval(() => {
      if (!state.data) return;
      const previousTheme = document.body.dataset.theme;
      applyTheme(state.data);
      if (previousTheme !== document.body.dataset.theme) renderOrb(state.data);
      else if (Date.now() - (state.lastOrb || 0) > 5 * 60 * 1000) {
        state.lastOrb = Date.now();
        renderOrb(state.data);
      }
    }, 15000);
    setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - state.lastLoad > 10 * 60 * 1000) {
        loadWeather(state.place, { silent: true });
      }
    }, 60 * 1000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - state.lastLoad > 10 * 60 * 1000) {
        loadWeather(state.place, { silent: true });
      }
    });
  }

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
