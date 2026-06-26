const DEFAULT_FICO = `FLIGHT NO   FROM TO  PTD     ETD    PTA   ETA CFG  RGN  RMKS
207    LHR-MIA 0855   P  @0   1830 P -20  A8J69 LEK
285    LHR-SFO 0945   P  @0   2050 P -17  A8J69 LEE
193    LHR-DFW 1155   P  @0   2205 P -24  A8J69 LEH
269    LHR-LAX 1405   ?  @0   0120 ?  @0  A8J69 LEC
055    LHR-JNB 1800   ?  @0   0500 ?  @0  A8J69 LED
057    LHR-JNB 2020   P  @0   0725 P  @0  A8J69 LEA`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return handleStatus(request, env);
    }

    return new Response(appHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
};

async function handleStatus(request, env) {
  const url = new URL(request.url);

  if (!env.AVIATIONSTACK_KEY) {
    return jsonResponse({ ok: false, error: "Missing AVIATIONSTACK_KEY secret" }, 500);
  }

  const requestedFlights = (url.searchParams.get("flights") || "")
    .split(",")
    .map(normaliseFlight)
    .filter(Boolean);

  if (!requestedFlights.length) {
    return jsonResponse({ ok: false, error: "No flights supplied" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const results = {};
  for (const flight of requestedFlights) {
    results[flight] = emptyFlight(flight);
  }

  for (const flight of requestedFlights) {
    const variants = flightVariants(flight);
    let best = null;
    let bestVariant = null;
    let lastError = null;

    for (const variant of variants) {
      const apiUrl = new URL("http://api.aviationstack.com/v1/flights");
      apiUrl.searchParams.set("access_key", env.AVIATIONSTACK_KEY);
      apiUrl.searchParams.set("flight_iata", variant);
      apiUrl.searchParams.set("limit", "10");

      try {
        const apiResponse = await fetch(apiUrl.toString());
        const apiJson = await apiResponse.json();

        if (apiJson && apiJson.error) {
          lastError = apiJson.error;
          continue;
        }

        const data = Array.isArray(apiJson.data) ? apiJson.data : [];
        const match = pickBestMatch(data, variant);

        if (match) {
          best = match;
          bestVariant = variant;
          break;
        }
      } catch (err) {
        lastError = String(err);
      }
    }

    if (!best) {
      results[flight] = {
        ...emptyFlight(flight),
        error: lastError || null,
        tried: variants
      };
      continue;
    }

    const dep = best.departure || {};
    const arr = best.arrival || {};
    const rawStatus = best.flight_status || "unknown";
    const mapped = classifyFlight(rawStatus, dep, arr, best.live);

    results[flight] = {
      flight,
      lookup_flight: bestVariant,
      found: true,
      status: mapped.status,
      label: mapped.label,
      confidence: mapped.confidence,
      safe_by_status: mapped.safe_by_status,
      raw_status: rawStatus,
      flight_date: best.flight_date || null,
      departure: {
        scheduled: dep.scheduled || null,
        estimated: dep.estimated || null,
        actual: dep.actual || null,
        estimated_runway: dep.estimated_runway || null,
        actual_runway: dep.actual_runway || null,
        delay: dep.delay ?? null,
        terminal: dep.terminal || null,
        gate: dep.gate || null
      },
      arrival: {
        scheduled: arr.scheduled || null,
        estimated: arr.estimated || null,
        actual: arr.actual || null,
        estimated_runway: arr.estimated_runway || null,
        actual_runway: arr.actual_runway || null,
        delay: arr.delay ?? null,
        terminal: arr.terminal || null,
        gate: arr.gate || null
      },
      aircraft: best.aircraft || null,
      live: best.live || null
    };
  }

  const response = jsonResponse({
    ok: true,
    version: "v7.1",
    source: "aviationstack",
    updated: new Date().toISOString(),
    flights: results
  });

  response.headers.set("Cache-Control", "public, max-age=60");
  await cache.put(cacheKey, response.clone());
  return response;
}

function normaliseFlight(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function flightVariants(flight) {
  const variants = [flight];

  const m = flight.match(/^([A-Z]{2})(0+)(\d+)$/);
  if (m) variants.push(m[1] + String(Number(m[3])));

  return [...new Set(variants)];
}

function emptyFlight(flight) {
  return {
    flight,
    lookup_flight: null,
    found: false,
    status: "unknown",
    label: "Unknown",
    confidence: "none",
    safe_by_status: false,
    raw_status: null,
    flight_date: null,
    departure: null,
    arrival: null,
    aircraft: null,
    live: null
  };
}

function pickBestMatch(data, requestedFlight) {
  const matches = data.filter(item => normaliseFlight(item?.flight?.iata) === requestedFlight);
  if (!matches.length) return null;

  const today = new Date().toISOString().slice(0, 10);

  // Do not use yesterday's already-landed overnight sector for today's BA055/BA057.
  const todayMatches = matches.filter(item => item.flight_date === today);
  if (!todayMatches.length) return null;

  const statusRank = {
    active: 1,
    scheduled: 2,
    landed: 3,
    cancelled: 4,
    diverted: 5,
    incident: 6
  };

  return todayMatches.sort((a, b) => {
    const ra = statusRank[a.flight_status] || 99;
    const rb = statusRank[b.flight_status] || 99;
    if (ra !== rb) return ra - rb;

    const ta = Date.parse(a?.departure?.scheduled || "") || 0;
    const tb = Date.parse(b?.departure?.scheduled || "") || 0;
    return ta - tb;
  })[0];
}

function classifyFlight(rawStatus, dep, arr, live) {
  if (rawStatus === "cancelled") {
    return { status: "cancelled", label: "Cancelled", confidence: "confirmed", safe_by_status: true };
  }

  if (rawStatus === "diverted") {
    return { status: "diverted", label: "Diverted", confidence: "confirmed", safe_by_status: true };
  }

  if (rawStatus === "incident") {
    return { status: "unknown", label: "Unknown", confidence: "uncertain", safe_by_status: false };
  }

  if (rawStatus === "landed" || arr?.actual || arr?.actual_runway) {
    return { status: "departed", label: "Departed", confidence: "confirmed", safe_by_status: true };
  }

  const hasDepartureEvidence = Boolean(dep?.actual || dep?.actual_runway || live);
  if (hasDepartureEvidence) {
    return { status: "departed", label: "Departed", confidence: "confirmed", safe_by_status: true };
  }

  const now = Date.now();
  const scheduled = dep?.scheduled ? Date.parse(dep.scheduled) : null;
  const estimated = dep?.estimated ? Date.parse(dep.estimated) : null;
  const pastSTD = scheduled ? now > scheduled : false;
  const estimatedLater = scheduled && estimated ? estimated > scheduled : false;

  if (rawStatus === "active") {
    return pastSTD
      ? { status: "delayed", label: "Delayed", confidence: "uncertain", safe_by_status: false }
      : { status: "planned", label: "Planned", confidence: "scheduled", safe_by_status: false };
  }

  if (rawStatus === "scheduled") {
    return (pastSTD || estimatedLater)
      ? { status: "delayed", label: "Delayed", confidence: "scheduled", safe_by_status: false }
      : { status: "planned", label: "Planned", confidence: "scheduled", safe_by_status: false };
  }

  return { status: rawStatus || "unknown", label: "Unknown", confidence: "unknown", safe_by_status: false };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function appHtml() {
  const escapedFico = DEFAULT_FICO.replace(/</g, "&lt;");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>HSB Reserve App</title>
<style>
:root{
  --bg:#05080c;
  --panel:#0b1118;
  --ink:#f4f7fb;
  --muted:#a8b0bb;
  --line:#26313c;
  --blue:#58a6ff;
  --green:#41d45a;
  --amber:#ffc400;
  --red:#ff4b4b;
  --grey:#aeb6bf;
}
*{box-sizing:border-box}
body{
  margin:0;
  padding:14px;
  background:radial-gradient(circle at top,#101923 0,#05080c 45%,#030507 100%);
  color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
}
.app{max-width:1220px;margin:0 auto;padding:8px 0 24px}
.header{
  display:grid;
  grid-template-columns:1fr auto;
  gap:12px;
  align-items:start;
  margin-bottom:12px;
}
h1{margin:0;font-size:1.65rem;letter-spacing:-.03em}
.version{
  font-size:.78rem;
  background:#102742;
  color:#80bdff;
  border:1px solid #1e4774;
  border-radius:8px;
  padding:4px 7px;
  margin-left:8px;
  vertical-align:4px;
}
.sub{margin:6px 0 0;color:var(--muted);font-size:.95rem}
.controls{
  display:grid;
  grid-template-columns:120px 120px 140px;
  gap:8px;
}
.control{
  background:linear-gradient(#101923,#0a1017);
  border:1px solid var(--line);
  border-radius:12px;
  padding:10px;
  text-align:center;
}
.control label{
  display:block;
  color:var(--muted);
  font-size:.72rem;
  text-transform:uppercase;
  margin-bottom:4px;
}
.control input{
  width:100%;
  border:0;
  background:transparent;
  color:var(--blue);
  font-weight:900;
  font-size:1.18rem;
  text-align:center;
}
.clock{font-weight:900;font-size:1.28rem;color:#fff}
.card{
  background:rgba(11,17,24,.94);
  border:1px solid var(--line);
  border-radius:14px;
  box-shadow:0 2px 16px rgba(0,0,0,.28);
  overflow:hidden;
  margin-bottom:12px;
}
.top-callable{
  border-color:rgba(255,196,0,.65);
  padding:14px 16px;
}
.callable-head{
  display:flex;
  justify-content:space-between;
  gap:10px;
  align-items:center;
  margin-bottom:8px;
  color:var(--amber);
  font-weight:900;
  font-size:1.35rem;
}
.callable-sub{color:var(--muted);font-size:.9rem;font-weight:500}
.callable-row{
  display:grid;
  grid-template-columns:28px 110px 80px 1fr 110px;
  gap:12px;
  align-items:center;
  padding:10px 0;
  border-top:1px solid rgba(255,255,255,.08);
  font-size:1.1rem;
}
.callable-row:first-of-type{border-top:0}
.callable-flight{font-weight:900}
.callable-call{color:var(--amber);font-weight:900}
.callable-time{color:var(--amber);font-weight:900;text-align:right}
.stats{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:10px;
  margin-bottom:12px;
}
.stat{
  background:linear-gradient(#0d141d,#080d13);
  border:1px solid var(--line);
  border-radius:12px;
  padding:12px;
  text-align:center;
  min-height:84px;
}
.stat .num{font-size:1.8rem;font-weight:900;margin-top:4px}
.stat .lbl{font-size:.76rem;text-transform:uppercase;font-weight:900;color:var(--muted);line-height:1.25}
.stat.safe{border-color:rgba(65,212,90,.45)}
.stat.safe .num,.stat.safe .lbl{color:var(--green)}
.stat.callable{border-color:rgba(255,196,0,.45)}
.stat.callable .num,.stat.callable .lbl{color:var(--amber)}
.stat.action{border-color:rgba(255,75,75,.45)}
.stat.action .num,.stat.action .lbl{color:var(--red)}
.stat.blue{border-color:rgba(88,166,255,.45)}
.stat.blue .num,.stat.blue .lbl{color:var(--blue)}
.stat.unknown .num,.stat.unknown .lbl{color:var(--grey)}
.fico{padding:14px 16px}
.fico-grid{display:grid;grid-template-columns:1fr 210px;gap:14px}
.fico label{display:block;color:var(--ink);font-weight:900;font-size:.82rem;margin-bottom:6px}
textarea{
  width:100%;
  min-height:130px;
  background:#f9fbff;
  color:#111;
  border:1px solid #cfd7e2;
  border-radius:12px;
  padding:10px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.88rem;
  line-height:1.25;
}
.button-col{display:flex;flex-direction:column;gap:10px;justify-content:flex-start}
button{
  border:1px solid #244b78;
  border-radius:10px;
  padding:11px 12px;
  background:#0b1a2b;
  color:#74b9ff;
  font-weight:900;
  font-size:.92rem;
}
button.primary{background:#111;color:#fff;border-color:#333}
.parse-note{margin-top:8px;color:var(--muted);font-size:.82rem}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;min-width:930px;border-collapse:collapse;font-size:.95rem}
th,td{
  border-bottom:1px solid var(--line);
  padding:8px 8px;
  text-align:left;
  white-space:nowrap;
  vertical-align:middle;
}
th{background:#111922;color:#c9d1d9;font-size:.78rem;font-weight:900}
td{color:#eef3f8}
.badge{font-weight:900;border-radius:8px;display:inline-block;padding:3px 7px}
.badge-green{background:rgba(65,212,90,.14);color:var(--green)}
.badge-amber{background:rgba(255,196,0,.14);color:var(--amber)}
.small{display:block;color:var(--muted);font-size:.72rem;margin-top:2px}
.status-planned{color:var(--green);font-weight:900}
.status-delayed,.status-live{color:var(--amber);font-weight:900}
.status-safe{color:var(--green);font-weight:900}
.status-unknown{color:var(--grey);font-weight:900}
.row-safe{background:rgba(65,212,90,.06)}
.row-pre{background:rgba(88,166,255,.07)}
.row-live{background:rgba(255,196,0,.06)}
.row-critical{background:rgba(255,75,75,.12)}
.row-departed{background:rgba(255,255,255,.035)}
.dot{
  display:inline-block;
  width:18px;
  height:18px;
  border-radius:50%;
  vertical-align:-4px;
  box-shadow:inset 0 2px 3px rgba(255,255,255,.85),inset 0 -3px 5px rgba(0,0,0,.3),0 1px 4px rgba(0,0,0,.5);
}
.dot-green{background:linear-gradient(#83ff83,#0cad2a)}
.dot-amber{background:linear-gradient(#ffd56a,#ff9800)}
.dot-red{background:linear-gradient(#ff7777,#d60000)}
.dot-blue{background:linear-gradient(#7db7ff,#1b64d8)}
.dot-grey{background:linear-gradient(#eee,#9aa3ad)}
.status-link{
  display:inline-block;
  text-decoration:none;
  background:#05080c;
  color:#58a6ff;
  border:1px solid #244b78;
  padding:6px 9px;
  border-radius:8px;
  font-size:.8rem;
  font-weight:900;
}
.legend{
  display:flex;
  gap:18px;
  flex-wrap:wrap;
  padding:11px 14px;
  color:#c9d1d9;
  font-size:.88rem;
}
.legend span{display:inline-flex;gap:7px;align-items:center}
.note{padding:12px 14px;color:var(--muted);font-size:.82rem;border-top:1px solid var(--line)}
@media(max-width:800px){
  .header{grid-template-columns:1fr}
  .controls{grid-template-columns:1fr 1fr 1fr}
  .stats{grid-template-columns:repeat(2,1fr)}
  .fico-grid{grid-template-columns:1fr}
  .callable-row{grid-template-columns:26px 90px 60px 1fr 90px;font-size:1rem}
  table{font-size:.9rem;min-width:900px}
}
</style>
</head>
<body>
<main class="app">
<section class="header">
  <div>
    <h1>HSB Reserve App <span class="version">v7.1</span></h1>
    <p class="sub">All times in Zulu (Z). Primary view shows flights you could still be called for.</p>
  </div>
  <div class="controls">
    <div class="control"><label for="hsbStart">HSB start</label><input id="hsbStart" type="time" value="12:00"></div>
    <div class="control"><label for="hsbEnd">HSB finish</label><input id="hsbEnd" type="time" value="20:00"></div>
    <div class="control"><label>UTC</label><div class="clock" id="utcClock">----Z</div></div>
  </div>
</section>

<section class="card top-callable" id="aliveList"></section>

<section class="stats" id="stats"></section>

<section class="card fico">
  <div class="fico-grid">
    <div>
      <label for="ficoInput">Paste BA/FICO flight list</label>
      <textarea id="ficoInput" spellcheck="false">${escapedFico}</textarea>
    </div>
    <div class="button-col">
      <button class="primary" id="parseBtn">Parse FICO list</button>
      <button id="statusBtn">Refresh flight status</button>
      <div id="parseNote" class="parse-note">Tomorrow rows such as 207/27 are ignored.</div>
    </div>
  </div>
</section>

<section class="card">
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Flight</th>
          <th>Route</th>
          <th>T/O</th>
          <th>Arr</th>
          <th>Block</th>
          <th>Call by</th>
          <th>Status</th>
          <th>Countdown</th>
          <th>Google</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="legend">
    <span><i class="dot dot-green"></i> Safe</span>
    <span><i class="dot dot-amber"></i> Still callable</span>
    <span><i class="dot dot-red"></i> Action required</span>
    <span><i class="dot dot-blue"></i> HSB not started</span>
    <span><i class="dot dot-grey"></i> Unknown</span>
  </div>
  <div class="note">Call by = earlier of latest legal call time or HSB finish. Rows remain chronological by scheduled take-off.</div>
</section>
</main>

<script>
let flights = [];
let statuses = {};
let lastStatusUpdate = null;

const HSB_TO_CHOCKS_LIMIT = 1140;
const CALL_BEFORE_TAKEOFF = 120;
const STORAGE_KEY = "hsb-reserve-fico-v7-1";

function toMin(t) {
  const p = t.split(":").map(Number);
  return p[0] * 60 + p[1];
}

function compactToMin(s) {
  s = String(s).replace(/\\D/g, "").padStart(4, "0");
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
}

function minToBlock(mins) {
  mins = Math.abs(mins);
  return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
}

function fmt(mins) {
  const plus = mins >= 1440 ? " +1" : "";
  mins = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(mins / 60)).padStart(2, "0") + String(mins % 60).padStart(2, "0") + "Z" + plus;
}

function fmtShort(mins) {
  return fmt(mins).replace("Z", "");
}

function dur(mins) {
  mins = Math.max(0, Math.abs(mins));
  return Math.floor(mins / 60) + "h " + String(mins % 60).padStart(2, "0") + "m";
}

function utcNowMinutes() {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function utcNowText() {
  const d = new Date();
  return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
}

function futureDelta(targetMins, nowMins) {
  let target = targetMins;
  while (target < nowMins - 720) target += 1440;
  return target - nowMins;
}

function normaliseEnd(start, end) {
  return end <= start ? end + 1440 : end;
}

function parseFico(text) {
  const parsed = [];

  for (const rawLine of text.split(/\\n/)) {
    const line = rawLine.trim();
    if (line.match(/^\\d{3}\\/\\d{1,2}/)) continue;

    const m = line.match(/^(\\d{3})\\s+([A-Z]{3})-([A-Z]{3})\\s+(\\d{4})\\S*\\s+\\S+\\s+\\S+\\s+(\\d{4})/);
    if (!m) continue;

    const [, num, from, to, ptd, pta] = m;
    const schedTO = compactToMin(ptd);
    let schedArr = compactToMin(pta);
    if (schedArr <= schedTO) schedArr += 1440;

    parsed.push({
      flight: "BA" + num,
      from,
      to,
      route: from + "-" + to,
      schedTO,
      schedArr,
      block: schedArr - schedTO
    });
  }

  return parsed.sort((a, b) => a.schedTO - b.schedTO);
}

async function refreshStatus() {
  if (!flights.length) return;

  const query = flights.map(f => f.flight).join(",");

  try {
    const res = await fetch("/api/status?flights=" + encodeURIComponent(query));
    const data = await res.json();

    if (data.ok && data.flights) {
      statuses = data.flights;
      lastStatusUpdate = new Date(data.updated);
      document.getElementById("parseNote").textContent = "Updated: " + lastStatusUpdate.toUTCString();
    } else {
      document.getElementById("parseNote").textContent = "Flight status error: " + (data.error || "unknown");
    }
  } catch (e) {
    document.getElementById("parseNote").textContent = "Flight status fetch failed: " + e;
  }

  render();
}

function parseAndRender() {
  const text = document.getElementById("ficoInput").value;
  localStorage.setItem(STORAGE_KEY, text);

  flights = parseFico(text);
  statuses = {};

  document.getElementById("parseNote").textContent = "Parsed " + flights.length + " flights. Tomorrow rows ignored.";

  render();
  refreshStatus();
}

function computeRows() {
  const startInput = document.getElementById("hsbStart").value;
  const endInput = document.getElementById("hsbEnd").value;
  if (!startInput || !endInput) return null;

  const hsbStart = toMin(startInput);
  const hsbEnd = normaliseEnd(hsbStart, toMin(endInput));
  const latestOnBlocks = hsbStart + HSB_TO_CHOCKS_LIMIT;
  const now = utcNowMinutes();

  const hsbStartDelta = futureDelta(hsbStart, now);
  const hsbFinishDelta = futureDelta(hsbEnd, now);
  const hsbNotStarted = hsbStartDelta > 0 && hsbStartDelta < 720;
  const hsbFinished = hsbFinishDelta < 0;

  const rows = flights.map(f => {
    const latestTO = latestOnBlocks - f.block;
    const latestCall = latestTO - CALL_BEFORE_TAKEOFF;
    const callBy = Math.min(latestCall, hsbEnd);
    const callByReason = hsbEnd < latestCall ? "HSB finish" : "Latest call";
    const delta = futureDelta(callBy, now);
    const fs = statuses[f.flight] || {
      status: "unknown",
      found: false,
      label: "Unknown",
      confidence: "none",
      safe_by_status: false
    };

    return { ...f, latestOnBlocks, latestTO, latestCall, callBy, callByReason, delta, fs };
  });

  return {
    rows,
    hsbStart,
    hsbEnd,
    latestOnBlocks,
    now,
    hsbStartDelta,
    hsbFinishDelta,
    hsbNotStarted,
    hsbFinished
  };
}

function isSafe(f, state) {
  return f.fs.safe_by_status || state.hsbFinished || f.delta < 0;
}

function isLive(f, state) {
  return !state.hsbNotStarted && !isSafe(f, state);
}

function dotClassFor(f, state) {
  if (state.hsbNotStarted) return "dot-blue";
  if (isSafe(f, state)) return "dot-green";
  if (!f.fs.found) return "dot-grey";
  if (f.delta <= 30) return "dot-red";
  return "dot-amber";
}

function rowClassFor(f, state) {
  if (state.hsbNotStarted) return "row-pre";
  if (isSafe(f, state)) return f.fs.safe_by_status ? "row-departed" : "row-safe";
  if (f.delta <= 30) return "row-critical";
  return "row-live";
}

function statusText(f, state) {
  if (f.fs.safe_by_status) return f.fs.label || "Departed";
  if (state.hsbFinished || f.delta < 0) return "Safe";
  if (!f.fs.found) return "Unknown";
  return f.fs.label || "Unknown";
}

function statusClass(f, state) {
  const s = statusText(f, state);
  if (s === "Planned") return "status-planned";
  if (s === "Delayed") return "status-delayed";
  if (s === "Safe" || s === "Departed") return "status-safe";
  if (s === "Unknown") return "status-unknown";
  return "status-live";
}

function countdownText(f, state) {
  if (state.hsbNotStarted) return "HSB starts " + dur(state.hsbStartDelta);
  if (isSafe(f, state)) return "Safe";
  return dur(f.delta) + " left";
}

function render() {
  const clock = document.getElementById("utcClock");
  if (clock) clock.textContent = utcNowText();

  const state = computeRows();
  if (!state) return;

  renderCallable(state);
  renderStats(state);
  renderTable(state);
}

function renderCallable(state) {
  const el = document.getElementById("aliveList");
  const live = state.rows.filter(f => isLive(f, state));

  if (state.hsbNotStarted) {
    el.innerHTML =
      "<div class='callable-head'><span><i class='dot dot-blue'></i> HSB NOT STARTED</span><span class='callable-sub'>Starts in " +
      dur(state.hsbStartDelta) +
      "</span></div>";
    return;
  }

  if (!live.length) {
    el.innerHTML =
      "<div class='callable-head'><span><i class='dot dot-green'></i> NO FLIGHTS STILL CALLABLE</span><span class='callable-sub'>Safe by time/status</span></div>";
    return;
  }

  el.innerHTML =
    "<div class='callable-head'><span><i class='dot dot-amber'></i> STILL CALLABLE (" +
    live.length +
    ")</span><span class='callable-sub'>Flights you could still be called for</span></div>" +
    live
      .map(
        f =>
          "<div class='callable-row'><i class='dot " +
          dotClassFor(f, state) +
          "'></i><div class='callable-flight'>" +
          f.flight +
          "</div><div>" +
          f.to +
          "</div><div class='callable-call'>Call by " +
          fmt(f.callBy) +
          "<span class='small'>" +
          f.callByReason +
          "</span></div><div class='callable-time'>" +
          dur(f.delta) +
          "</div></div>"
      )
      .join("");
}

function renderStats(state) {
  const safe = state.rows.filter(f => isSafe(f, state)).length;
  const live = state.rows.filter(f => isLive(f, state)).length;
  const action = state.rows.filter(f => isLive(f, state) && f.delta <= 30).length;
  const unknown = state.rows.filter(f => !f.fs.found).length;
  const notStarted = state.hsbNotStarted ? state.rows.length : 0;

  document.getElementById("stats").innerHTML =
    "<div class='stat safe'><i class='dot dot-green'></i><div class='num'>" +
    safe +
    "</div><div class='lbl'>Safe</div></div>" +
    "<div class='stat callable'><i class='dot dot-amber'></i><div class='num'>" +
    live +
    "</div><div class='lbl'>Still callable</div></div>" +
    "<div class='stat action'><i class='dot dot-red'></i><div class='num'>" +
    action +
    "</div><div class='lbl'>Action required</div></div>" +
    "<div class='stat blue'><i class='dot dot-blue'></i><div class='num'>" +
    notStarted +
    "</div><div class='lbl'>HSB not started</div></div>" +
    "<div class='stat unknown'><i class='dot dot-grey'></i><div class='num'>" +
    unknown +
    "</div><div class='lbl'>Unknown</div></div>";
}

function renderTable(state) {
  const rowsEl = document.getElementById("rows");
  rowsEl.innerHTML = "";

  for (const f of state.rows) {
    const googleUrl = "https://www.google.com/search?q=" + encodeURIComponent(f.flight);
    const callBadge = isSafe(f, state) ? "badge-green" : "badge-amber";
    const tr = document.createElement("tr");

    tr.className = rowClassFor(f, state);
    tr.innerHTML =
      "<td><span class='dot " +
      dotClassFor(f, state) +
      "'></span></td>" +
      "<td><strong>" +
      f.flight +
      "</strong></td>" +
      "<td>" +
      f.route +
      "</td>" +
      "<td>" +
      fmtShort(f.schedTO) +
      "</td>" +
      "<td>" +
      fmtShort(f.schedArr) +
      "</td>" +
      "<td>" +
      minToBlock(f.block) +
      "</td>" +
      "<td><span class='badge " +
      callBadge +
      "'>" +
      fmt(f.callBy) +
      "</span><span class='small'>" +
      f.callByReason +
      "</span></td>" +
      "<td class='" +
      statusClass(f, state) +
      "'>" +
      statusText(f, state) +
      "</td>" +
      "<td>" +
      countdownText(f, state) +
      "</td>" +
      "<td><a class='status-link' target='_blank' rel='noopener' href='" +
      googleUrl +
      "'>Check</a></td>";

    rowsEl.appendChild(tr);
  }
}

document.getElementById("parseBtn").addEventListener("click", parseAndRender);
document.getElementById("statusBtn").addEventListener("click", refreshStatus);
document.getElementById("hsbStart").addEventListener("input", render);
document.getElementById("hsbEnd").addEventListener("input", render);

const saved = localStorage.getItem(STORAGE_KEY);
if (saved) document.getElementById("ficoInput").value = saved;

parseAndRender();
setInterval(render, 10000);
setInterval(refreshStatus, 60000);
</script>
</body>
</html>`;
}
