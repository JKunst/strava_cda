// Vermogensmodel hardlopen: basis (ECOR), helling (Minetti), wind (apparente wind), duwkar.
// Zelfde model als de Python-versie van WindWatt.

export const G = 9.81;
const R_AIR = 287.05;

export const TERRAIN = {
  open: { label: "Open (polder, strand)", z0: 0.03 },
  rural: { label: "Landelijk", z0: 0.10 },
  forest: { label: "Bos / dorp", z0: 0.30 },
  city: { label: "Stad", z0: 0.50 },
};

export const SURFACE = {
  asphalt: { label: "Asfalt", crr: 0.010 },
  pavers: { label: "Klinkers", crr: 0.014 },
  gravel: { label: "Grind / onverhard", crr: 0.022 },
  sand: { label: "Zand / gras", crr: 0.045 },
};

export function duBoisBSA(heightCm, massKg) {
  return 0.007184 * massKg ** 0.425 * heightCm ** 0.725;
}

export function runnerFrontalArea(heightCm, massKg) {
  return 0.266 * duBoisBSA(heightCm, massKg);
}

export function cartCdA(p) {
  return p.cartWidth * p.cartHeight * p.cartFill * p.cartCd;
}

export function runnerCdA(p) {
  return p.runnerCd * runnerFrontalArea(p.heightCm, p.massKg);
}

export function totalCdA(p, withCart) {
  const r = runnerCdA(p);
  return withCart ? cartCdA(p) + r * (1 - p.shielding) : r;
}

export function airDensity(tempC, pressureHpa) {
  return (pressureHpa * 100) / (R_AIR * (tempC + 273.15));
}

export function windHeightFactor(z0, zRunner = 1, zRef = 10) {
  return Math.log(zRunner / z0) / Math.log(zRef / z0);
}

export function minettiCost(i) {
  i = Math.max(-0.45, Math.min(0.45, i));
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function bearings(lat, lon, window = 9) {
  const n = lat.length;
  const b = new Array(n).fill(0);
  for (let k = 0; k < n - 1; k++) {
    const p1 = rad(lat[k]), p2 = rad(lat[k + 1]), dl = rad(lon[k + 1] - lon[k]);
    const x = Math.sin(dl) * Math.cos(p2);
    const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    b[k] = (deg(Math.atan2(x, y)) + 360) % 360;
  }
  if (n > 1) b[n - 1] = b[n - 2];
  // gladstrijken via eenheidsvectoren
  const h = Math.floor(window / 2);
  const s = b.map((v) => Math.sin(rad(v)));
  const c = b.map((v) => Math.cos(rad(v)));
  return b.map((_, k) => {
    let ss = 0, cc = 0;
    for (let j = Math.max(0, k - h); j <= Math.min(n - 1, k + h); j++) { ss += s[j]; cc += c[j]; }
    return (deg(Math.atan2(ss, cc)) + 360) % 360;
  });
}

export function rollingMean(arr, window) {
  const h = Math.floor(window / 2), n = arr.length, out = new Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, k - h); j <= Math.min(n - 1, k + h); j++) { sum += arr[j]; cnt++; }
    out[k] = sum / cnt;
  }
  return out;
}

/**
 * track: {time[], speed[], grade[], bearing[], windSpeed[], windFrom[], tempC[], pressure[]}
 * p: profiel; run: {withCart, cartLoadKg, crr, z0}
 */
export function computePower(track, p, run) {
  const n = track.time.length;
  const m = p.massKg;
  const c0 = minettiCost(0);
  const hf = windHeightFactor(run.z0);
  const cda = totalCdA(p, run.withCart);
  const cdaBare = runnerCdA(p);
  const mc = run.withCart ? p.cartMass + run.cartLoadKg : 0;
  const o = {
    headwind: new Array(n), rho: new Array(n), pFlat: new Array(n), pGrade: new Array(n),
    pAirBare: new Array(n), pAirCartExtra: new Array(n), pWind: new Array(n),
    pCart: new Array(n), power: new Array(n), powerBare: new Array(n),
  };
  for (let k = 0; k < n; k++) {
    const v = Math.max(0, track.speed[k]);
    const g = track.grade[k];
    const pFlat = p.ecor * m * v;
    const pRunner = pFlat * Math.max(minettiCost(g) / c0, 0);
    const w = track.windSpeed[k] * hf;
    const rel = rad(track.windFrom[k] - track.bearing[k]);
    const hw = w * Math.cos(rel), cw = w * Math.sin(rel);
    const rho = airDensity(track.tempC[k], track.pressure[k]);
    const vLong = v + hw;
    const vApp = Math.hypot(vLong, cw);
    const pAir = 0.5 * rho * cda * vApp * vLong * v;
    const pAirStill = 0.5 * rho * cda * v ** 3;
    const pAirBare = 0.5 * rho * cdaBare * v ** 3;
    let pCart = 0;
    if (run.withCart) pCart = Math.max(run.crr * mc * G * v + mc * G * v * g, 0);
    o.headwind[k] = hw;
    o.rho[k] = rho;
    o.pFlat[k] = pFlat;
    o.pGrade[k] = pRunner - pFlat;
    o.pAirBare[k] = pAirBare;
    o.pAirCartExtra[k] = pAirStill - pAirBare;
    o.pWind[k] = pAir - pAirStill;
    o.pCart[k] = pCart;
    o.power[k] = Math.max(pRunner + pAir + pCart, 0);
    o.powerBare[k] = pFlat + pAirBare;
  }
  return o;
}

function resample1s(time, values) {
  const t0 = time[0], t1 = time[time.length - 1];
  const out = [];
  let j = 0;
  for (let t = t0; t <= t1; t++) {
    while (j < time.length - 2 && time[j + 1] < t) j++;
    const ta = time[j], tb = time[j + 1] ?? ta;
    if (tb - ta > 10 && t > ta) continue; // pauze overslaan
    const f = tb > ta ? (t - ta) / (tb - ta) : 0;
    out.push(values[j] + f * ((values[j + 1] ?? values[j]) - values[j]));
  }
  return out;
}

export function normalizedPower(time, power) {
  const s = resample1s(time, power);
  if (s.length < 30) return s.reduce((a, b) => a + b, 0) / Math.max(s.length, 1);
  let sum = 0;
  for (let k = 0; k < 30; k++) sum += s[k];
  let acc = (sum / 30) ** 4, cnt = 1;
  for (let k = 30; k < s.length; k++) {
    sum += s[k] - s[k - 30];
    acc += (sum / 30) ** 4;
    cnt++;
  }
  return (acc / cnt) ** 0.25;
}

export function summarize(track, o, p, ftp) {
  const n = track.time.length;
  let secs = 0, dist = 0, hwSecs = 0, twSecs = 0;
  const kj = { total: 0, bare: 0, flat: 0, grade: 0, wind: 0, cartAir: 0, cartMech: 0 };
  let rhoSum = 0;
  for (let k = 0; k < n; k++) {
    let dt = k === 0 ? (track.time[1] - track.time[0] || 1) : track.time[k] - track.time[k - 1];
    dt = Math.min(Math.max(dt, 0), 10);
    if (track.speed[k] <= 0.5) dt = 0;
    secs += dt;
    dist += track.speed[k] * dt;
    if (o.headwind[k] > 0.5) hwSecs += dt;
    if (o.headwind[k] < -0.5) twSecs += dt;
    kj.total += o.power[k] * dt;
    kj.bare += o.powerBare[k] * dt;
    kj.flat += (o.pFlat[k] + o.pAirBare[k]) * dt;
    kj.grade += o.pGrade[k] * dt;
    kj.wind += o.pWind[k] * dt;
    kj.cartAir += o.pAirCartExtra[k] * dt;
    kj.cartMech += o.pCart[k] * dt;
    rhoSum += o.rho[k];
  }
  for (const key in kj) kj[key] /= 1000;
  const np = normalizedPower(track.time, o.power);
  const npBare = normalizedPower(track.time, o.powerBare);
  const hours = secs / 3600;
  const IF = ftp ? np / ftp : 0;
  const ifBare = ftp ? npBare / ftp : 0;
  const avgP = secs ? (kj.total * 1000) / secs : 0;

  // tempo waarbij vlak, windstil, zonder kar hetzelfde gemiddelde vermogen nodig is
  const a = 0.5 * (rhoSum / n) * runnerCdA(p);
  const b = p.ecor * p.massKg;
  let vEq = avgP / b;
  for (let k = 0; k < 30; k++) vEq -= (b * vEq + a * vEq ** 3 - avgP) / (b + 3 * a * vEq ** 2);

  return {
    movingS: secs, distanceM: dist, avgSpeed: secs ? dist / secs : 0,
    avgPower: avgP, np, npBare, IF,
    load: hours * IF ** 2 * 100, loadBare: hours * ifBare ** 2 * 100,
    extraPct: kj.bare ? (kj.total / kj.bare - 1) * 100 : 0,
    kj, vEquiv: Math.max(vEq, 0),
    headwindShare: secs ? hwSecs / secs : 0, tailwindShare: secs ? twSecs / secs : 0,
  };
}

// ------------------------------------------------------------------ rondes

const TRACK_KEYS = ["time", "speed", "grade", "bearing", "windSpeed", "windFrom", "tempC", "pressure"];

export function sliceTrack(track, i0, i1, f = 1) {
  const s = {};
  for (const k of TRACK_KEYS) s[k] = track[k].slice(i0, i1 + 1);
  if (f !== 1) s.speed = s.speed.map((v) => v * f);
  return s;
}

function moveWeights(time, speed) {
  return time.map((t, k) => {
    let dt = k === 0 ? (time[1] - time[0] || 1) : t - time[k - 1];
    dt = Math.min(Math.max(dt, 0), 10);
    return speed[k] > 0.5 ? dt : 0;
  });
}

function wmean(arr, w) {
  let s = 0, ws = 0;
  for (let k = 0; k < arr.length; k++) { s += arr[k] * w[k]; ws += w[k]; }
  return ws ? s / ws : 0;
}

/** Snelheid waarbij vlak, windstil en zonder kar vermogen P nodig is. */
export function equivSpeed(P, p, rho = 1.225) {
  const a = 0.5 * rho * runnerCdA(p), b = p.ecor * p.massKg;
  let v = P / b;
  for (let k = 0; k < 30; k++) v -= (b * v + a * v ** 3 - P) / (b + 3 * a * v ** 2);
  return Math.max(v, 0);
}

/**
 * Ronde i0..i1: gemiddeld vermogen met de werkelijke opzet, en de snelheidsfactor
 * waarmee je bij hetzelfde vermogen zou lopen
 *  - fNoCart: zonder kar, maar met dezelfde wind en helling
 *  - fBare:   vlak, windstil, zonder kar
 */
export function lapStats(track, p, run, i0, i1) {
  const s = sliceTrack(track, i0, i1);
  const w = moveWeights(s.time, s.speed);
  const o = computePower(s, p, run);
  const P = wmean(o.power, w);
  let secs = 0, dist = 0;
  for (let k = 0; k < w.length; k++) { secs += w[k]; dist += s.speed[k] * w[k]; }
  const v = secs ? dist / secs : 0;
  const noCart = { ...run, withCart: false };
  // Uniforme schaal van de snelheid: alle tijdstappen schalen gelijk, dus de weging blijft dezelfde.
  const pAt = (f) => wmean(computePower(sliceTrack(track, i0, i1, f), p, noCart).power, w);
  let lo = 0.3, hi = 3;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (pAt(mid) < P) lo = mid; else hi = mid;
  }
  const vBare = equivSpeed(P, p, wmean(o.rho, w) || 1.225);
  return { secs, dist, v, power: P, fNoCart: (lo + hi) / 2, fBare: v ? vBare / v : 1 };
}

export function thresholdFromPace(paceSPerKm, p, rho = 1.225) {
  const v = 1000 / paceSPerKm;
  return p.ecor * p.massKg * v + 0.5 * rho * runnerCdA(p) * v ** 3;
}

export function paceStr(v) {
  if (!(v > 0.1)) return "–";
  const s = 1000 / v;
  let mm = Math.floor(s / 60), ss = Math.round(s % 60);
  if (ss === 60) { mm++; ss = 0; }
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export function compass(d) {
  const names = ["N", "NNO", "NO", "ONO", "O", "OZO", "ZO", "ZZO", "Z", "ZZW", "ZW", "WZW", "W", "WNW", "NW", "NNW"];
  return names[Math.floor(((d % 360) + 360) % 360 / 22.5 + 0.5) % 16];
}

/** Interpoleer uurlijkse Open-Meteo-data naar trackpunten (wind via u/v). */
export function interpolateWeather(hourly, tUnix) {
  const ht = hourly.time;
  const u = [], v = [];
  for (let k = 0; k < ht.length; k++) {
    const ws = hourly.wind_speed_10m[k], wd = rad(hourly.wind_direction_10m[k]);
    u.push(ws * Math.sin(wd)); v.push(ws * Math.cos(wd));
  }
  const interp = (arr, t) => {
    if (t <= ht[0]) return arr[0];
    if (t >= ht[ht.length - 1]) return arr[arr.length - 1];
    let j = 0;
    while (ht[j + 1] < t) j++;
    const f = (t - ht[j]) / (ht[j + 1] - ht[j]);
    return arr[j] + f * (arr[j + 1] - arr[j]);
  };
  const out = { windSpeed: [], windFrom: [], tempC: [], pressure: [] };
  for (const t of tUnix) {
    const ui = interp(u, t), vi = interp(v, t);
    out.windSpeed.push(Math.hypot(ui, vi));
    out.windFrom.push((deg(Math.atan2(ui, vi)) + 360) % 360);
    out.tempC.push(interp(hourly.temperature_2m, t));
    out.pressure.push(interp(hourly.surface_pressure, t));
  }
  return out;
}
