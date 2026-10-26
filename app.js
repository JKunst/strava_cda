import * as ph from "./physics.js";

// ------------------------------------------------------------------ opslag
const LS = {
  get(k, d) { try { const v = localStorage.getItem("ww." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ww." + k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
  del(k) { try { localStorage.removeItem("ww." + k); } catch {} },
};

const idb = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("windwatt", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("streams");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("streams", mode);
      const req = fn(t.objectStore("streams"));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx("readonly", (s) => s.get(k)).catch(() => undefined),
    set: (k, v) => tx("readwrite", (s) => s.put(v, k)).catch(() => undefined),
    clear: () => tx("readwrite", (s) => s.clear()).catch(() => undefined),
  };
})();

const DEFAULT_PROFILE = {
  heightCm: 182, massKg: 73, ecor: 1.0, threshPace: "4:30", kid1Kg: 10, kid2Kg: 17,
  runnerCd: 0.80, shielding: 0.35, cartMass: 12.5, cartWidth: 0.80, cartHeight: 0.75, cartFill: 0.80, cartCd: 1.0,
};
const DEFAULT_SETUP = { cart: "none", extraKg: 0, surface: "asphalt", terrain: "rural", manual: false, windMs: 6, windFrom: 250 };
const CART = [
  ["none", "Geen"], ["empty", "Leeg"], ["kid1", "Kind 1"], ["kid2", "Kind 2"], ["both", "Beide"],
];
const DEMO_ID = "demo";

let profile = { ...DEFAULT_PROFILE, ...LS.get("profile", {}) };
const state = { id: null, meta: null, base: null, weather: null, laps: [], track: null, run: null };

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => Number(x).toLocaleString("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ Strava
const STRAVA = "https://www.strava.com";
const redirectUri = () => location.origin + location.pathname;
const creds = () => LS.get("strava", {});

async function exchange(body) {
  const c = creds();
  const r = await fetch(`${STRAVA}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
  });
  if (!r.ok) throw new Error(`Strava token: ${r.status}`);
  const tok = await r.json();
  LS.set("strava", { ...creds(), token: { ...(creds().token || {}), ...tok } });
  return tok;
}

async function accessToken() {
  const t = creds().token;
  if (!t) throw new Error("Niet gekoppeld met Strava");
  if (t.expires_at && t.expires_at > Date.now() / 1000 + 60) return t.access_token;
  const n = await exchange({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  return n.access_token;
}

async function api(path) {
  const r = await fetch(`${STRAVA}/api/v3${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (r.status === 429) throw new Error("Strava-limiet bereikt, probeer het over een kwartier opnieuw");
  if (!r.ok) throw new Error(`Strava ${r.status}`);
  return r.json();
}

async function syncActivities() {
  const acts = await api("/athlete/activities?per_page=80");
  const keep = acts
    .filter((a) => ["Run", "TrailRun", "Walk", "Hike"].includes(a.sport_type || a.type) && a.start_latlng?.length)
    .map((a) => ({ id: a.id, name: a.name, start_date: a.start_date, start_date_local: a.start_date_local,
      distance: a.distance, moving_time: a.moving_time, sport_type: a.sport_type }));
  LS.set("activities", keep);
  return keep.length;
}

async function getStreams(id) {
  const cached = await idb.get(id);
  if (cached) return cached;
  const raw = await api(`/activities/${id}/streams?keys=time,latlng,distance,altitude,velocity_smooth,grade_smooth,watts&key_by_type=true`);
  const s = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.data]));
  await idb.set(id, s);
  return s;
}

async function getLaps(id) {
  const key = "laps:" + id;
  const cached = await idb.get(key);
  if (cached) return cached;
  const raw = await api(`/activities/${id}/laps`);
  const laps = raw.map((l) => ({ name: l.name, start_index: l.start_index, end_index: l.end_index,
    distance: l.distance, moving_time: l.moving_time, elapsed_time: l.elapsed_time, start_date: l.start_date }));
  await idb.set(key, laps);
  return laps;
}

function mapLaps(laps, base, meta) {
  const n = base.time.length, t0 = Date.parse(meta.start_date) / 1000;
  return laps.map((l) => {
    let i0 = l.start_index, i1 = l.end_index;
    if (!(i1 < n && i0 < i1)) {
      const off = Date.parse(l.start_date) / 1000 - t0;
      i0 = base.time.findIndex((t) => t >= off);
      i1 = base.time.findLastIndex((t) => t <= off + l.elapsed_time);
    }
    return { ...l, i0, i1: Math.min(i1, n - 1) };
  }).filter((l) => l.i0 >= 0 && l.i1 - l.i0 >= 3);
}

// ------------------------------------------------------------------ weer
async function getWeather(id, lat, lon, startUnix, endUnix) {
  const all = LS.get("weather", {});
  if (all[id]) return all[id];
  const day = (u) => new Date(u * 1000).toISOString().slice(0, 10);
  const q = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    start_date: day(startUnix - 3600), end_date: day(endUnix + 3600),
    hourly: "temperature_2m,surface_pressure,wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms", timezone: "GMT", timeformat: "unixtime",
  });
  let err;
  for (const base of ["https://historical-forecast-api.open-meteo.com/v1/forecast", "https://archive-api.open-meteo.com/v1/archive"]) {
    try {
      const r = await fetch(`${base}?${q}`);
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      const h = (await r.json()).hourly;
      const ok = h.time.map((_, k) => h.wind_speed_10m[k] != null && h.wind_direction_10m[k] != null);
      if (!ok.some(Boolean)) throw new Error("geen winddata voor deze datum");
      const pick = (arr) => arr.filter((_, k) => ok[k]);
      const w = { time: pick(h.time), temperature_2m: pick(h.temperature_2m), surface_pressure: pick(h.surface_pressure),
        wind_speed_10m: pick(h.wind_speed_10m), wind_direction_10m: pick(h.wind_direction_10m) };
      // cache klein houden: laatste 60 trainingen
      const keys = Object.keys(all);
      if (keys.length > 60) delete all[keys[0]];
      all[id] = w;
      LS.set("weather", all);
      return w;
    } catch (e) { err = e; }
  }
  throw err;
}

// ------------------------------------------------------------------ tracks
function demoTrack() {
  const lat0 = 51.92, lon0 = 4.48;
  // [type, waarde, snelheid]: afstand in m of tijd in s
  const segs = [["dist", 2000, 3.0]];
  for (let r = 1; r <= 5; r++) segs.push(["time", 180, 4.0], ["time", 120, 2.8]);
  segs.push(["dist", 2000, 3.0]);
  const total = segs.reduce((a, [k, x, v]) => a + (k === "dist" ? x : x * v), 0), half = total / 2;
  const time = [], lat = [], lon = [], alt = [], dist = [], speed = [], laps = [];
  let d = 0, t = 0;
  const push = (v) => {
    const x = d < half ? d : total - d;
    time.push(t); dist.push(d); speed.push(v); lat.push(lat0);
    lon.push(lon0 + x / (111320 * Math.cos((lat0 * Math.PI) / 180)));
    alt.push(2 + 12 * Math.exp(-(((x - 2500) / 250) ** 2)));
  };
  for (const [kind, x, v] of segs) {
    const i0 = time.length, d0 = d;
    if (kind === "dist") { const end = d + x; while (d < end - 1e-6) { push(v); t += 1; d = Math.min(d + v, end); } }
    else for (let k = 0; k < x; k++) { push(v); t += 1; d += v; }
    const dur = time.length - i0;
    laps.push({ i0, i1: time.length - 1, distance: d - d0, moving_time: dur, elapsed_time: dur });
  }
  push(3.0);
  const n = time.length;
  const grade = alt.map((_, k) => {
    const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
    return (alt[b] - alt[a]) / Math.max(dist[b] - dist[a], 0.1);
  });
  return {
    meta: { id: DEMO_ID, name: "Demo: 5 × 3 min", start_date: "2026-10-01T08:00:00Z", start_date_local: "2026-10-01T10:00:00", distance: total, moving_time: t },
    base: { time, lat, lon, dist, speed, grade, startUnix: Date.parse("2026-10-01T08:00:00Z") / 1000 },
    laps,
  };
}

function trackFromStreams(s, meta) {
  const ll = s.latlng;
  const n = ll.length;
  const time = s.time, dist = s.distance;
  const speed = s.velocity_smooth || time.map((_, k) => k ? (dist[k] - dist[k - 1]) / Math.max(time[k] - time[k - 1], 1) : 0);
  let grade;
  if (s.grade_smooth) grade = s.grade_smooth.map((g) => g / 100);
  else {
    const alt = s.altitude || new Array(n).fill(0);
    grade = alt.map((_, k) => {
      const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
      return (alt[b] - alt[a]) / Math.max(dist[b] - dist[a], 1);
    });
  }
  grade = ph.rollingMean(grade, 15).map((g) => Math.max(-0.3, Math.min(0.3, g)));
  return {
    time, dist, speed, grade,
    lat: ll.map((p) => p[0]), lon: ll.map((p) => p[1]),
    deviceWatts: s.watts || null,
    startUnix: Date.parse(meta.start_date) / 1000,
  };
}

// ------------------------------------------------------------------ rekenen
function thresholdPower() {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(profile.threshPace).trim());
  const secs = m ? +m[1] * 60 + +m[2] : 270;
  return ph.thresholdFromPace(secs, profile);
}

function runSetup(id) {
  const runs = LS.get("runs", {});
  const demo = id === DEMO_ID ? { manual: true, cart: "both" } : {};
  return { ...DEFAULT_SETUP, ...demo, ...(runs[id]?.setup || {}) };
}

function saveRun(id, setup, result) {
  const runs = LS.get("runs", {});
  runs[id] = { ...(runs[id] || {}), setup, result, meta: state.meta };
  LS.set("runs", runs);
}

function cartLoad(setup) {
  const kids = { none: 0, empty: 0, kid1: profile.kid1Kg, kid2: profile.kid2Kg, both: profile.kid1Kg + profile.kid2Kg }[setup.cart];
  return kids + (setup.cart === "none" ? 0 : +setup.extraKg || 0);
}

function recompute() {
  if (!state.base) return;
  const b = state.base, setup = runSetup(state.id), n = b.time.length;
  const track = {
    time: b.time, speed: b.speed, grade: b.grade, bearing: ph.bearings(b.lat, b.lon),
  };
  let weatherNote = "";
  if (state.weather && !setup.manual) {
    const w = ph.interpolateWeather(state.weather, b.time.map((t) => b.startUnix + t));
    Object.assign(track, { windSpeed: w.windSpeed, windFrom: w.windFrom, tempC: w.tempC, pressure: w.pressure });
    weatherNote = "Open-Meteo";
  } else {
    track.windSpeed = new Array(n).fill(+setup.windMs || 0);
    track.windFrom = new Array(n).fill(+setup.windFrom || 0);
    const t0 = state.weather ? ph.interpolateWeather(state.weather, [b.startUnix]) : null;
    track.tempC = new Array(n).fill(t0 ? t0.tempC[0] : 12);
    track.pressure = new Array(n).fill(t0 ? t0.pressure[0] : 1013);
    weatherNote = "handmatig";
  }
  const run = {
    withCart: setup.cart !== "none", cartLoadKg: cartLoad(setup),
    crr: ph.SURFACE[setup.surface].crr, z0: ph.TERRAIN[setup.terrain].z0,
  };
  const o = ph.computePower(track, profile, run);
  const ftp = thresholdPower();
  const res = ph.summarize(track, o, profile, ftp);
  saveRun(state.id, setup, res);

  // gemiddelde wind
  let u = 0, v = 0, ws = 0, tc = 0;
  for (let k = 0; k < n; k++) {
    u += Math.sin((track.windFrom[k] * Math.PI) / 180); v += Math.cos((track.windFrom[k] * Math.PI) / 180);
    ws += track.windSpeed[k]; tc += track.tempC[k];
  }
  const wdir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const wsAvg = ws / n;
  const hf = ph.windHeightFactor(run.z0);
  $("windLine").innerHTML =
    `Wind <b>${fmt(wsAvg, 1)} m/s uit ${ph.compass(wdir)}</b> (${weatherNote}), ~${fmt(wsAvg * hf, 1)} m/s op loophoogte · ` +
    `tegen <b>${fmt(res.headwindShare * 100)}%</b> / mee <b>${fmt(res.tailwindShare * 100)}%</b> van de tijd · ` +
    `${fmt(tc / n)} °C · CdA ${fmt(ph.totalCdA(profile, run.withCart), 2)} m²` +
    (run.withCart ? ` · kar ${fmt(profile.cartMass + run.cartLoadKg, 1)} kg` : "");

  renderTiles(res);
  renderPowerChart(b, o);
  renderBars(res);
  state.track = track; state.run = run;
  renderLaps();
  renderMap(b, o);
}

// ------------------------------------------------------------------ weergave
function renderTiles(r) {
  const dLoad = r.load - r.loadBare;
  $("tiles").innerHTML = `
    <div class="tile"><div class="k">Belasting rTSS</div><div class="v">${fmt(r.load)}</div>
      <div class="d"><span class="${dLoad > 0.5 ? "up" : ""}">${dLoad >= 0 ? "+" : ""}${fmt(dLoad)}</span> t.o.v. kaal (${fmt(r.loadBare)})</div></div>
    <div class="tile"><div class="k">Extra werk</div><div class="v">${r.extraPct >= 0 ? "+" : ""}${fmt(r.extraPct)}<small>%</small></div>
      <div class="d">${fmt(r.kj.total)} kJ vs ${fmt(r.kj.bare)} kJ kaal</div></div>
    <div class="tile"><div class="k">Voelde als</div><div class="v">${ph.paceStr(r.vEquiv)}<small>/km</small></div>
      <div class="d">gelopen ${ph.paceStr(r.avgSpeed)}/km</div></div>
    <div class="tile"><div class="k">Gem. / NP</div><div class="v">${fmt(r.avgPower)}<small> / ${fmt(r.np)} W</small></div>
      <div class="d">IF ${fmt(r.IF, 2)} · drempel ${fmt(thresholdPower())} W</div></div>`;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(+t.toFixed(6));
  return ticks;
}

function downsample(x, ys, max = 500) {
  const n = x.length, step = Math.max(1, Math.ceil(n / max));
  const idx = [];
  for (let k = 0; k < n; k += step) idx.push(k);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return { x: idx.map((k) => x[k]), ys: ys.map((y) => idx.map((k) => y[k])) };
}

function renderPowerChart(b, o) {
  const km = b.dist.map((d) => d / 1000);
  const series = [
    { name: "Kaal (vlak, windstil, geen kar)", y: ph.rollingMean(o.powerBare, 21), color: "var(--neutral)", dash: "2 4" },
    { name: "Model (wind + helling + kar)", y: ph.rollingMean(o.power, 21), color: "var(--accent)" },
  ];
  if (b.deviceWatts) series.push({ name: "Horloge / footpod", y: ph.rollingMean(b.deviceWatts, 21), color: "var(--device)" });
  $("pLegend").innerHTML = series.map((s) =>
    `<span><i class="${s.dash ? "dot" : ""}" style="${s.dash ? "" : `background:${s.color}`}"></i>${s.name}</span>`).join("");
  const hwS = ph.rollingMean(o.headwind, 21);
  lineChart($("pChart"), km, series, {
    unit: "W",
    extra: (k) => `<div>tegenwind ${fmt(hwS[k], 1)} m/s</div>`,
    xfmt: (v) => `${fmt(v, 1)} km`,
    xunit: "km",
  });
}

function lineChart(el, x, series, opt) {
  const ds = downsample(x, [...series.map((s) => s.y), Array.from(x.keys())]);
  const X = ds.x, Ys = ds.ys.slice(0, -1), srcIdx = ds.ys[ds.ys.length - 1];
  const draw = () => {
    const W = el.clientWidth, H = el.clientHeight;
    if (!W) return;
    const m = { l: 40, r: 8, t: 8, b: 24 };
    const all = Ys.flat().filter(Number.isFinite);
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || 10;
    lo = Math.max(0, lo - pad); hi = hi + pad;
    const yt = niceTicks(lo, hi, 4);
    lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]);
    const x0 = X[0], x1 = X[X.length - 1] || 1;
    const sx = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
    const sy = (v) => H - m.b - ((v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
    const xt = niceTicks(x0, x1, Math.max(3, Math.floor(W / 90)));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vermogen over afstand">`;
    for (const t of yt) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--line)" stroke-width="1"/><text x="${m.l - 6}" y="${sy(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
    for (const t of xt) svg += `<text x="${sx(t)}" y="${H - 6}" text-anchor="middle">${fmt(t, t % 1 ? 1 : 0)}</text>`;
    if (opt.xunit) svg += `<text x="${W - m.r}" y="${H - 6}" text-anchor="end">${opt.xunit}</text>`;
    Ys.forEach((y, i) => {
      const s = series[i];
      const d = y.map((v, k) => `${k ? "L" : "M"}${sx(X[k]).toFixed(1)},${sy(v).toFixed(1)}`).join("");
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/>`;
    });
    svg += `<line id="xh" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>`;
    svg += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" style="cursor:crosshair"/></svg><div class="tip" hidden></div>`;
    el.innerHTML = svg;
    const tip = el.querySelector(".tip"), xh = el.querySelector("#xh"), rect = el.querySelector("rect");
    const move = (ev) => {
      const bx = el.getBoundingClientRect();
      const px = Math.max(m.l, Math.min(W - m.r, ev.clientX - bx.left));
      const xv = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
      let k = 0;
      while (k < X.length - 1 && X[k + 1] < xv) k++;
      xh.setAttribute("x1", sx(X[k])); xh.setAttribute("x2", sx(X[k])); xh.setAttribute("visibility", "visible");
      tip.innerHTML = `<div><b>${opt.xfmt(X[k])}</b></div>` +
        Ys.map((y, i) => `<div><i style="background:${series[i].color}"></i>${fmt(y[k])} ${opt.unit}</div>`).join("") +
        (opt.extra ? opt.extra(srcIdx[k]) : "");
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const px2 = sx(X[k]);
      tip.style.left = `${px2 + 10 + tw > W ? Math.max(0, px2 - tw - 10) : px2 + 10}px`;
    };
    const hide = () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); };
    rect.addEventListener("pointermove", move);
    rect.addEventListener("pointerdown", move);
    rect.addEventListener("pointerleave", hide);
  };
  el._draw = draw;
  draw();
}

function renderBars(r) {
  const rows = [
    ["Basis (vlak, windstil)", r.kj.flat],
    ["Helling", r.kj.grade],
    ["Wind", r.kj.wind],
  ];
  if (r.kj.cartAir || r.kj.cartMech) rows.push(["Kar: luchtweerstand", r.kj.cartAir], ["Kar: rol + klim", r.kj.cartMech]);
  const minV = Math.min(0, ...rows.map((x) => x[1])), maxV = Math.max(...rows.map((x) => x[1]), 1);
  const span = maxV - minV;
  const z = (-minV / span) * 100;
  $("bars").innerHTML = rows.map(([lab, v], i) => {
    const w = (Math.abs(v) / span) * 100;
    const left = v >= 0 ? z : z - w;
    return `<div class="bar"><span class="lab">${lab}</span><span class="track"><span class="zero" style="left:${z}%"></span>
      <span class="fill ${v >= 0 ? "pos" : "neg"}" style="left:${left}%;width:${Math.max(w, v ? 0.6 : 0)}%"></span></span>
      <span class="val">${i && v >= 0 ? "+" : ""}${fmt(v)} kJ</span></div>`;
  }).join("");
}

function fmtTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

function renderLaps() {
  const laps = state.laps || [];
  const seg = $("lapSeg");
  if (laps.length < 2) {
    seg.hidden = true; $("lapSum").innerHTML = ""; $("lapNote").textContent = "";
    $("lapBody").innerHTML = `<p class="note">Deze training heeft één ronde. Druk bij intervallen op de lapknop van je horloge (of zet auto-lap aan); dan verschijnen de rondes hier.</p>`;
    return;
  }
  seg.hidden = false;
  const withCart = state.run.withCart;
  const mode = withCart ? LS.get("lapMode", "nocart") : "bare";
  seg.innerHTML = [["nocart", "Zonder kar"], ["bare", "Kaal: ook geen wind en helling"]].map(([k, lab]) =>
    `<button type="button" data-mode="${k}" aria-pressed="${mode === k}" ${k === "nocart" && !withCart ? "disabled" : ""}>${lab}</button>`).join("");

  const kinds = LS.get("runs", {})[state.id]?.lapKinds || {};
  const rows = laps.map((l, i) => {
    const s = ph.lapStats(state.track, profile, state.run, l.i0, l.i1);
    const f = mode === "nocart" ? s.fNoCart : s.fBare;
    const t = l.moving_time || s.secs, d = l.distance || s.dist;
    const kind = kinds[i] || guessLapKind(l);
    return { i, n: i + 1, kind, d, t, tDef: l.elapsed_time || t, v: d / t, f, P: s.power, v2: (d / t) * f };
  });
  const sorted = rows.map((r) => r.v).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  rows.forEach((r) => { r.fast = r.v > med * 1.06; });
  const fast = rows.filter((r) => r.fast);

  const lab = mode === "nocart" ? "Zonder kar" : "Kaal";
  if (fast.length) {
    const d = fast.reduce((a, r) => a + r.d, 0), t = fast.reduce((a, r) => a + r.t, 0);
    const t2 = fast.reduce((a, r) => a + r.t / r.f, 0);
    const v = d / t, v2 = d / t2;
    $("lapSum").innerHTML = `<div class="lapsum">
      <div><div class="k">Snelle rondes (${fast.length})</div><div class="big">${ph.paceStr(v)}<small>/km</small></div></div>
      <div><div class="k">${lab}</div><div class="big">${ph.paceStr(v2)}<small>/km</small></div></div>
      <div><div class="k">Verschil</div><div class="big">${v2 >= v ? "−" : "+"}${fmt(Math.abs(1000 / v - 1000 / v2))}<small> s/km</small></div></div>
    </div>`;
  } else $("lapSum").innerHTML = "";

  const km = (d) => d >= 1000 ? `${fmt(d / 1000, Math.abs(d % 1000) < 5 ? 0 : 2)} km` : `${fmt(d)} m`;
  const sign = (x) => (x < 0 ? "−" : "+") + fmt(Math.abs(x));
  $("lapBody").innerHTML = `<table class="laps"><thead><tr><th>#</th><th>Interval</th><th class="num">Gelopen</th><th class="num">W</th>
    <th class="num">${mode === "nocart" ? "Zonder kar" : "Kaal"}</th></tr></thead><tbody>` +
    rows.map((r) => {
      const isTime = r.kind === "time";
      const def = isTime ? fmtTime(r.tDef) : km(r.d);
      const done = isTime ? `${km(r.d)}<small>${ph.paceStr(r.v)}/km</small>` : `${fmtTime(r.t)}<small>${ph.paceStr(r.v)}/km</small>`;
      const est = isTime
        ? `<b>${km(r.d * r.f)}</b><small>${ph.paceStr(r.v2)}/km · ${sign(r.d * r.f - r.d)} m</small>`
        : `<b>${fmtTime(r.t / r.f)}</b><small>${ph.paceStr(r.v2)}/km · ${sign(r.t / r.f - r.t)} s</small>`;
      return `<tr class="${r.fast ? "fast" : ""}"><td>${r.n}</td>
        <td><button type="button" class="kind" data-lap="${r.i}" aria-label="Interval ${r.n}: ${isTime ? "op tijd" : "op afstand"}, tik om te wisselen">${def}<small>${isTime ? "op tijd" : "op afstand"}</small></button></td>
        <td class="num">${done}</td><td class="num">${fmt(r.P)}</td><td class="num">${est}</td></tr>`;
    }).join("") + `</tbody></table>`;
  $("lapNote").textContent = (mode === "nocart"
    ? "Zelfde vermogen, zonder kar, met dezelfde wind en helling. "
    : "Zelfde vermogen, vlak, windstil en zonder kar. ") +
    "Op afstand: tijd voor dezelfde afstand. Op tijd: afstand in dezelfde tijd. Tik op een interval om te wisselen. Vet met streep: snelle ronde.";
}

function guessLapKind(l) {
  const t = l.elapsed_time || l.moving_time, d = l.distance;
  const tRound = t >= 30 && Math.abs(t - Math.round(t / 15) * 15) <= 1;
  const dRound = d >= 100 && Math.abs(d - Math.round(d / 100) * 100) <= Math.max(5, d * 0.01);
  return tRound && !dRound ? "time" : "dist";
}

let map, segLayer;
function cssColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

function renderMap(b, o) {
  if (!window.L) { $("map").textContent = "Kaart kon niet laden (offline?)."; return; }
  if (!map) {
    map = L.map("map", { zoomControl: false, attributionControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    segLayer = L.layerGroup().addTo(map);
  }
  segLayer.clearLayers();
  const n = b.lat.length, step = Math.max(1, Math.ceil(n / 700));
  const hw = ph.rollingMean(o.headwind, 15);
  const abs = hw.map(Math.abs).sort((a, c) => a - c);
  const lim = Math.max(2, abs[Math.floor(abs.length * 0.95)] || 2);
  const head = hexToRgb(cssColor("--head")), tail = hexToRgb(cssColor("--tail")), neu = hexToRgb(cssColor("--neutral"));
  for (let k = 0; k + step < n; k += step) {
    const t = Math.max(-1, Math.min(1, hw[k] / lim));
    const to = t >= 0 ? head : tail, f = Math.abs(t);
    const c = neu.map((v, i) => Math.round(v + (to[i] - v) * f));
    L.polyline([[b.lat[k], b.lon[k]], [b.lat[k + step], b.lon[k + step]]], { color: `rgb(${c})`, weight: 5, opacity: 0.95, lineCap: "round" })
      .bindTooltip(`${hw[k] >= 0 ? "tegen" : "mee"} ${fmt(Math.abs(hw[k]), 1)} m/s`)
      .addTo(segLayer);
  }
  map.fitBounds(L.latLngBounds(b.lat.map((la, k) => [la, b.lon[k]])), { padding: [16, 16] });
  setTimeout(() => map.invalidateSize(), 50);
}

function renderSetup() {
  const s = runSetup(state.id);
  $("cartSeg").innerHTML = CART.map(([k, lab]) => {
    const kg = { kid1: profile.kid1Kg, kid2: profile.kid2Kg, both: profile.kid1Kg + profile.kid2Kg }[k];
    return `<button type="button" data-cart="${k}" aria-pressed="${s.cart === k}">${lab}${kg ? ` (${fmt(kg)} kg)` : ""}</button>`;
  }).join("");
  $("surfaceSel").value = s.surface;
  $("terrainSel").value = s.terrain;
  $("extraKg").value = s.extraKg;
  $("extraKg").disabled = s.cart === "none";
  $("surfaceSel").disabled = s.cart === "none";
  $("windManual").checked = s.manual;
  $("windMs").value = s.windMs;
  $("windFrom").value = s.windFrom;
  $("windMs").disabled = $("windFrom").disabled = !s.manual;
}

function updateSetup(patch) {
  const runs = LS.get("runs", {});
  const setup = { ...runSetup(state.id), ...patch };
  runs[state.id] = { ...(runs[state.id] || {}), setup, meta: state.meta };
  LS.set("runs", runs);
  renderSetup();
  recompute();
}

function renderLog() {
  const runs = Object.entries(LS.get("runs", {})).filter(([id, r]) => id !== DEMO_ID && r.result);
  if (!runs.length) {
    $("logTable").innerHTML = `<p class="note">Nog niets geanalyseerd. Open een training op het tabblad Training; die verschijnt dan hier.</p>`;
    $("wkChart").innerHTML = "";
    return;
  }
  const rows = runs.map(([id, r]) => ({ id, ...r })).sort((a, b) => b.meta.start_date.localeCompare(a.meta.start_date));
  const cartLab = Object.fromEntries(CART);
  $("logTable").innerHTML = `<table><thead><tr><th>Datum</th><th>Training</th><th>Kar</th><th class="num">km</th><th class="num">Tempo</th><th class="num">Voelde als</th><th class="num">rTSS</th><th class="num">Kaal</th><th class="num">Extra</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${(r.meta.start_date_local || r.meta.start_date).slice(0, 10)}</td><td>${esc(r.meta.name).slice(0, 28)}</td><td>${cartLab[r.setup.cart]}</td>
      <td class="num">${fmt(r.result.distanceM / 1000, 1)}</td><td class="num">${ph.paceStr(r.result.avgSpeed)}</td><td class="num">${ph.paceStr(r.result.vEquiv)}</td>
      <td class="num"><b>${fmt(r.result.load)}</b></td><td class="num">${fmt(r.result.loadBare)}</td><td class="num">${r.result.extraPct >= 0 ? "+" : ""}${fmt(r.result.extraPct)}%</td></tr>`).join("") +
    `</tbody></table>`;

  // per week (maandag)
  const wk = {};
  for (const r of rows) {
    const d = new Date((r.meta.start_date_local || r.meta.start_date).slice(0, 10) + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = d.toISOString().slice(0, 10);
    wk[key] = (wk[key] || 0) + r.result.load;
  }
  const keys = Object.keys(wk).sort().slice(-12);
  const el = $("wkChart");
  const draw = () => {
    const W = el.clientWidth, H = el.clientHeight, m = { l: 34, r: 4, t: 8, b: 22 };
    if (!W) return;
    const max = Math.max(...keys.map((k) => wk[k]), 1);
    const yt = niceTicks(0, max, 3), top = yt[yt.length - 1];
    const bw = (W - m.l - m.r) / keys.length;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Belasting per week">`;
    for (const t of yt) { const y = H - m.b - (t / top) * (H - m.t - m.b); svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${m.l - 6}" y="${y + 4}" text-anchor="end">${fmt(t)}</text>`; }
    keys.forEach((k, i) => {
      const h = (wk[k] / top) * (H - m.t - m.b), x = m.l + i * bw + 2, w = Math.max(bw - 4, 2), y = H - m.b - h;
      svg += `<path d="M${x},${H - m.b}V${y + Math.min(4, h)}q0,-4 4,-4h${w - 8}q4,0 4,4V${H - m.b}Z" fill="var(--accent)"><title>Week van ${k.slice(8, 10)}-${k.slice(5, 7)}: ${fmt(wk[k])}</title></path>`;
      if (keys.length <= 8 || i % 2 === 0) svg += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${k.slice(8, 10)}-${k.slice(5, 7)}</text>`;
    });
    el.innerHTML = svg + "</svg>";
  };
  el._draw = draw;
  draw();
}

function renderCdA() {
  const area = ph.runnerFrontalArea(profile.heightCm, profile.massKg);
  $("cdaOut").innerHTML = `
    <div class="kv"><span>Frontaal oppervlak loper</span><b>${fmt(area, 2)} m²</b></div>
    <div class="kv"><span>CdA loper</span><b>${fmt(ph.runnerCdA(profile), 2)} m²</b></div>
    <div class="kv"><span>CdA kar</span><b>${fmt(ph.cartCdA(profile), 2)} m²</b></div>
    <div class="kv"><span>CdA loper + kar</span><b>${fmt(ph.totalCdA(profile, true), 2)} m²</b></div>
    <div class="kv"><span>Drempelvermogen</span><b>${fmt(thresholdPower())} W</b></div>`;
}

// ------------------------------------------------------------------ flow
function setStatus() {
  const c = creds();
  $("status").textContent = c.token ? "Strava gekoppeld" : "Demo · koppel Strava bij Instellingen";
  $("syncBtn").hidden = !c.token;
  $("stravaNote").textContent = c.token ? "Gekoppeld. Tokens staan alleen in deze browser." : "Niet gekoppeld.";
}

function fillActivities() {
  const acts = LS.get("activities", []);
  const opts = acts.map((a) => `<option value="${a.id}">${(a.start_date_local || a.start_date).slice(0, 10)} · ${esc(a.name)} · ${fmt(a.distance / 1000, 1)} km</option>`);
  opts.push(`<option value="${DEMO_ID}">Demo-run (zonder Strava)</option>`);
  $("actSel").innerHTML = opts.join("");
}

async function selectActivity(id) {
  state.id = id;
  LS.set("lastId", id);
  $("runHead").innerHTML = `<span class="note"><span class="spin"></span> Laden</span>`;
  try {
    if (id === DEMO_ID) {
      const d = demoTrack();
      state.meta = d.meta; state.base = d.base; state.weather = null; state.laps = d.laps;
    } else {
      state.meta = LS.get("activities", []).find((a) => String(a.id) === String(id));
      const s = await getStreams(id);
      if (!s.latlng) throw new Error("Deze training heeft geen GPS-data");
      state.base = trackFromStreams(s, state.meta);
      try { state.laps = mapLaps(await getLaps(id), state.base, state.meta); } catch { state.laps = []; }
      const b = state.base;
      const mid = Math.floor(b.lat.length / 2);
      try {
        state.weather = await getWeather(id, b.lat[mid], b.lon[mid], b.startUnix, b.startUnix + b.time[b.time.length - 1]);
      } catch (e) {
        state.weather = null;
        if (!runSetup(id).manual) {
          const runs = LS.get("runs", {});
          runs[id] = { ...(runs[id] || {}), setup: { ...runSetup(id), manual: true }, meta: state.meta };
          LS.set("runs", runs);
        }
        $("syncNote").textContent = `Weer niet gevonden (${e.message}); wind handmatig.`;
      }
    }
    const m = state.meta;
    const dur = m.moving_time, h = Math.floor(dur / 3600), mm = Math.floor((dur % 3600) / 60);
    $("runHead").innerHTML = `<div class="name">${esc(m.name)}</div>
      <div class="sub">${new Date(m.start_date).toLocaleString("nl-NL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${fmt(m.distance / 1000, 2)} km · ${h ? h + " u " : ""}${mm} min</div>`;
    renderSetup();
    recompute();
  } catch (e) {
    $("runHead").innerHTML = `<p class="note err">${esc(e.message)}</p>`;
  }
}

function bindSettings() {
  for (const k of Object.keys(DEFAULT_PROFILE)) {
    const el = $("p_" + k);
    if (!el) continue;
    el.value = profile[k];
    el.addEventListener("change", () => {
      const v = el.type === "number" ? parseFloat(el.value) : el.value;
      if (el.type === "number" && !Number.isFinite(v)) { el.value = profile[k]; return; }
      profile[k] = v;
      LS.set("profile", profile);
      renderCdA();
      renderSetup();
      recompute();
    });
  }
  const c = creds();
  $("s_clientId").value = c.clientId || "";
  $("s_clientSecret").value = c.clientSecret || "";
  const saveCreds = () => LS.set("strava", { ...creds(), clientId: $("s_clientId").value.trim(), clientSecret: $("s_clientSecret").value.trim() });
  $("s_clientId").addEventListener("change", saveCreds);
  $("s_clientSecret").addEventListener("change", saveCreds);
  $("cbDomain").textContent = location.hostname || "(lokaal bestand)";
  $("connectBtn").addEventListener("click", () => {
    saveCreds();
    const id = creds().clientId;
    if (!id || !creds().clientSecret) { $("stravaNote").textContent = "Vul eerst client ID en secret in."; return; }
    location.href = `${STRAVA}/oauth/mobile/authorize?client_id=${encodeURIComponent(id)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri())}&approval_prompt=auto&scope=activity:read_all`;
  });
  $("disconnectBtn").addEventListener("click", () => {
    const c2 = creds(); delete c2.token; LS.set("strava", c2); LS.del("activities");
    fillActivities(); setStatus();
  });
  $("refreshBtn").addEventListener("click", async () => {
    saveCreds();
    try {
      LS.set("strava", { ...creds(), token: { refresh_token: $("s_refresh").value.trim(), expires_at: 0 } });
      await accessToken();
      $("s_refresh").value = "";
      setStatus();
      await doSync();
    } catch (e) { $("stravaNote").textContent = `Mislukt: ${e.message}`; }
  });
  $("clearCache").addEventListener("click", async () => {
    await idb.clear(); LS.del("weather");
    $("storeNote").textContent = "Cache gewist. Instellingen en logboek zijn bewaard.";
  });
}

async function doSync() {
  $("syncNote").innerHTML = `<span class="spin"></span> Strava ophalen`;
  try {
    const n = await syncActivities();
    $("syncNote").textContent = `${n} trainingen`;
    fillActivities();
    const first = LS.get("activities", [])[0];
    if (first) { $("actSel").value = first.id; selectActivity(String(first.id)); }
  } catch (e) {
    $("syncNote").textContent = e.message;
  }
}

function bindRun() {
  $("surfaceSel").innerHTML = Object.entries(ph.SURFACE).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("terrainSel").innerHTML = Object.entries(ph.TERRAIN).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("cartSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) updateSetup({ cart: b.dataset.cart }); });
  $("surfaceSel").addEventListener("change", (e) => updateSetup({ surface: e.target.value }));
  $("terrainSel").addEventListener("change", (e) => updateSetup({ terrain: e.target.value }));
  $("extraKg").addEventListener("change", (e) => updateSetup({ extraKg: parseFloat(e.target.value) || 0 }));
  $("windManual").addEventListener("change", (e) => updateSetup({ manual: e.target.checked }));
  $("windMs").addEventListener("change", (e) => updateSetup({ windMs: parseFloat(e.target.value) || 0 }));
  $("windFrom").addEventListener("change", (e) => updateSetup({ windFrom: ((parseFloat(e.target.value) || 0) % 360 + 360) % 360 }));
  $("actSel").addEventListener("change", (e) => selectActivity(e.target.value));
  $("syncBtn").addEventListener("click", doSync);
  $("lapBody").addEventListener("click", (e) => {
    const b = e.target.closest("button.kind");
    if (!b) return;
    const runs = LS.get("runs", {});
    const r = runs[state.id] || (runs[state.id] = { setup: runSetup(state.id), meta: state.meta });
    const i = b.dataset.lap, cur = r.lapKinds?.[i] || guessLapKind(state.laps[i]);
    r.lapKinds = { ...(r.lapKinds || {}), [i]: cur === "time" ? "dist" : "time" };
    LS.set("runs", runs);
    renderLaps();
  });
  $("lapSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    LS.set("lapMode", b.dataset.mode);
    renderLaps();
  });
}

function bindTabs() {
  document.querySelectorAll("nav.tabs button").forEach((btn) => btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "page");
    for (const v of ["run", "log", "set"]) $("view-" + v).hidden = v !== btn.dataset.view;
    if (btn.dataset.view === "log") renderLog();
    if (btn.dataset.view === "set") renderCdA();
    if (btn.dataset.view === "run") { $("pChart")._draw?.(); map?.invalidateSize(); }
    scrollTo(0, 0);
  }));
}

async function init() {
  bindTabs(); bindRun(); bindSettings();
  const qs = new URLSearchParams(location.search);
  if (qs.get("code")) {
    try {
      await exchange({ code: qs.get("code"), grant_type: "authorization_code" });
      history.replaceState(null, "", redirectUri());
      setStatus();
      await doSync();
    } catch (e) {
      $("stravaNote").textContent = `Koppelen mislukt: ${e.message}`;
    }
  } else if (qs.get("error")) {
    history.replaceState(null, "", redirectUri());
  }
  setStatus();
  fillActivities();
  const last = LS.get("lastId");
  const ids = [...$("actSel").options].map((o) => o.value);
  const id = ids.includes(String(last)) ? String(last) : ids[0];
  $("actSel").value = id;
  await selectActivity(id);
  let t;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { $("pChart")._draw?.(); $("wkChart")._draw?.(); }, 150); });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
