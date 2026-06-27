const MONTHLY_CAP_USD = 8.0;
const COST_PER_FLIGHT_USD = 0.005;
const CACHE_TTL_SECONDS = 600;

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
    if (url.pathname === "/api/debug") return handleDebug(env);
    if (url.pathname === "/api/usage") return handleUsage(env);
    if (url.pathname === "/api/status") return handleStatus(request, env);

    return new Response(renderHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}

async function handleDebug(env) {
  return json({
    ok: true,
    version: "v15",
    has_usage_kv: !!env.USAGE_KV,
    has_flightaware_key: !!env.FLIGHTAWARE_API_KEY,
    cap_usd: MONTHLY_CAP_USD,
    cost_per_flight_usd: COST_PER_FLIGHT_USD,
    cache_ttl_seconds: CACHE_TTL_SECONDS
  });
}

async function handleUsage(env) {
  if (!env.USAGE_KV) {
    return json({ ok: false, blocked: true, error: "Missing USAGE_KV binding", cap_usd: MONTHLY_CAP_USD }, 500);
  }
  const usage = await readUsage(env);
  return json({
    ok: true,
    version: "v15",
    month: monthKey(),
    cap_usd: MONTHLY_CAP_USD,
    used_usd: usage.cost_usd,
    calls: usage.calls,
    remaining_usd: roundMoney(Math.max(0, MONTHLY_CAP_USD - usage.cost_usd)),
    cost_per_flight_usd: COST_PER_FLIGHT_USD,
    cache_ttl_seconds: CACHE_TTL_SECONDS
  });
}

async function handleStatus(request, env) {
  if (!env.USAGE_KV) {
    return json({ ok: false, blocked: true, error: "Missing USAGE_KV binding. Paid calls blocked." }, 500);
  }
  if (!env.FLIGHTAWARE_API_KEY) {
    return json({ ok: false, blocked: true, error: "Missing FLIGHTAWARE_API_KEY secret. Paid calls blocked." }, 500);
  }

  const url = new URL(request.url);
  const flights = (url.searchParams.get("flights") || "")
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);

  if (!flights.length) return json({ ok: false, error: "No flights supplied" }, 400);

  const usage = await readUsage(env);
  const results = {};
  const uncached = [];

  for (const flight of flights) {
    const cached = await readCache(env, flight);
    if (cached) results[flight] = { ...cached, cache: "hit" };
    else uncached.push(flight);
  }

  const estimatedCost = roundMoney(uncached.length * COST_PER_FLIGHT_USD);
  const projectedCost = roundMoney(usage.cost_usd + estimatedCost);

  if (projectedCost > MONTHLY_CAP_USD) {
    return json({
      ok: false,
      blocked: true,
      error: "Monthly app cap would be exceeded. No paid calls made.",
      cap_usd: MONTHLY_CAP_USD,
      used_usd: usage.cost_usd,
      estimated_cost_usd: estimatedCost,
      projected_cost_usd: projectedCost,
      cached_results: Object.keys(results).length,
      blocked_paid_calls: uncached.length,
      flights: results
    }, 402);
  }

  let paidCalls = 0;
  const errors = [];

  for (const flight of uncached) {
    try {
      const data = await fetchAeroApi(flight, env.FLIGHTAWARE_API_KEY);
      const mapped = mapAeroFlight(flight, data);
      results[flight] = { ...mapped, cache: "miss" };
      await writeCache(env, flight, mapped);
      paidCalls++;
    } catch (e) {
      errors.push(flight + ": " + String(e.message || e));
      results[flight] = {
        flight,
        found: false,
        status: "unknown",
        label: "Unknown",
        safe_by_status: false,
        error: String(e.message || e),
        cache: "error"
      };
    }
  }

  if (paidCalls > 0) {
    usage.calls += paidCalls;
    usage.cost_usd = roundMoney(usage.cost_usd + paidCalls * COST_PER_FLIGHT_USD);
    usage.updated = new Date().toISOString();
    await writeUsage(env, usage);
  }

  return json({
    ok: true,
    version: "v15",
    source: "flightaware_aeroapi",
    updated: new Date().toISOString(),
    used_usd: usage.cost_usd,
    cap_usd: MONTHLY_CAP_USD,
    paid_calls_this_refresh: paidCalls,
    estimated_cost_this_refresh_usd: roundMoney(paidCalls * COST_PER_FLIGHT_USD),
    cache_hits: flights.length - uncached.length,
    errors,
    flights: results
  });
}

async function readUsage(env) {
  const stored = await env.USAGE_KV.get("usage:" + monthKey(), "json");
  if (stored && typeof stored.calls === "number" && typeof stored.cost_usd === "number") return stored;
  return { month: monthKey(), calls: 0, cost_usd: 0, updated: null };
}

async function writeUsage(env, usage) {
  await env.USAGE_KV.put("usage:" + monthKey(), JSON.stringify(usage), { expirationTtl: 60 * 60 * 24 * 370 });
}

async function readCache(env, flight) {
  const stored = await env.USAGE_KV.get("cache:" + monthKey() + ":" + flight, "json");
  if (!stored || !stored.saved_at || !stored.data) return null;
  const age = (Date.now() - Date.parse(stored.saved_at)) / 1000;
  if (age > CACHE_TTL_SECONDS) return null;
  return stored.data;
}

async function writeCache(env, flight, data) {
  await env.USAGE_KV.put("cache:" + monthKey() + ":" + flight, JSON.stringify({
    saved_at: new Date().toISOString(),
    data
  }), { expirationTtl: CACHE_TTL_SECONDS + 60 });
}

async function fetchAeroApi(flight, apiKey) {
  const endpoint = new URL("https://aeroapi.flightaware.com/aeroapi/flights/" + encodeURIComponent(flight));
  endpoint.searchParams.set("max_pages", "1");

  const response = await fetch(endpoint.toString(), {
    headers: { "x-apikey": apiKey, "accept": "application/json" }
  });
  const body = await response.text();

  if (!response.ok) throw new Error("AeroAPI " + response.status + ": " + body.slice(0, 240));

  try { return JSON.parse(body); }
  catch { throw new Error("AeroAPI returned non-JSON: " + body.slice(0, 120)); }
}

function mapAeroFlight(requestedFlight, data) {
  const list = Array.isArray(data && data.flights) ? data.flights : [];
  const best = pickBestRecord(requestedFlight, list);
  if (!best) return {
    flight: requestedFlight,
    found: false,
    status: "unknown",
    label: "Unknown",
    safe_by_status: false,
    raw_status: null
  };

  const c = classifyRecord(best);
  return {
    flight: requestedFlight,
    found: true,
    status: c.status,
    label: c.label,
    safe_by_status: c.safe_by_status,
    confidence: c.confidence,
    raw_status: best.status || null,
    ident: best.ident || null,
    fa_flight_id: best.fa_flight_id || null,
    scheduled_out: best.scheduled_out || null,
    estimated_out: best.estimated_out || null,
    actual_out: best.actual_out || null,
    scheduled_off: best.scheduled_off || null,
    estimated_off: best.estimated_off || null,
    actual_off: best.actual_off || null,
    scheduled_on: best.scheduled_on || null,
    estimated_on: best.estimated_on || null,
    actual_on: best.actual_on || null,
    scheduled_in: best.scheduled_in || null,
    estimated_in: best.estimated_in || null,
    actual_in: best.actual_in || null,
    progress_percent: best.progress_percent ?? null
  };
}

function pickBestRecord(requestedFlight, list) {
  if (!list.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const reqNum = requestedFlight.startsWith("BA") ? requestedFlight.slice(2).replace(/^0+/, "") : requestedFlight;

  const candidates = list.filter(item => {
    const ident = String(item.ident || item.ident_iata || "").replace(/\s+/g, "").toUpperCase();
    const identNum = ident.replace(/^BAW/i, "").replace(/^BA/i, "").replace(/^0+/, "");
    return !ident || ident === requestedFlight || identNum === reqNum;
  });

  const usable = candidates.length ? candidates : list;
  const todayish = usable.filter(item => {
    const t = item.scheduled_out || item.estimated_out || item.actual_out || item.scheduled_off || item.estimated_off || item.actual_off;
    return t && String(t).slice(0, 10) === today;
  });

  const ranked = (todayish.length ? todayish : usable).sort((a, b) => {
    const ta = Date.parse(a.scheduled_out || a.estimated_out || a.actual_out || a.scheduled_off || "") || 0;
    const tb = Date.parse(b.scheduled_out || b.estimated_out || b.actual_out || b.scheduled_off || "") || 0;
    return Math.abs(Date.now() - ta) - Math.abs(Date.now() - tb);
  });
  return ranked[0];
}

function classifyRecord(f) {
  const s = String(f.status || "").toLowerCase();

  if (s.includes("cancel")) return { status: "cancelled", label: "Cancelled", safe_by_status: true, confidence: "confirmed" };
  if (s.includes("divert")) return { status: "diverted", label: "Diverted", safe_by_status: true, confidence: "confirmed" };

  const departedEvidence = Boolean(f.actual_out || f.actual_off || f.actual_on || f.actual_in);
  if (departedEvidence || s.includes("departed") || s.includes("airborne") || s.includes("en route") || s.includes("enroute") || s.includes("arrived") || s.includes("landed")) {
    return { status: "departed", label: "Departed", safe_by_status: true, confidence: "confirmed" };
  }

  const scheduled = Date.parse(f.scheduled_out || f.scheduled_off || "");
  const estimated = Date.parse(f.estimated_out || f.estimated_off || "");
  const pastStd = scheduled && Date.now() > scheduled;
  const estimatedLate = scheduled && estimated && estimated > scheduled;

  if (s.includes("delay") || pastStd || estimatedLate) return { status: "delayed", label: "Delayed", safe_by_status: false, confidence: "aeroapi" };
  if (scheduled || s.includes("scheduled") || s.includes("planned")) return { status: "planned", label: "Planned", safe_by_status: false, confidence: "aeroapi" };

  return { status: "unknown", label: "Unknown", safe_by_status: false, confidence: "unknown" };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>HSB Reserve App</title>
<style>
:root{--bg:#05080c;--ink:#f4f7fb;--muted:#a8b0bb;--line:#26313c;--blue:#58a6ff;--green:#41d45a;--amber:#ffc400;--red:#ff4b4b;--grey:#aeb6bf}
*{box-sizing:border-box}
body{margin:0;padding:14px;background:radial-gradient(circle at top,#101923 0,#05080c 45%,#030507 100%);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.app{max-width:1220px;margin:0 auto;padding:8px 0 24px}
.header{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start;margin-bottom:12px}
h1{margin:0;font-size:1.65rem}.version{font-size:.78rem;background:#102742;color:#80bdff;border:1px solid #1e4774;border-radius:8px;padding:4px 7px;margin-left:8px;vertical-align:4px}.sub{margin:6px 0 0;color:var(--muted);font-size:.95rem}
.controls{display:grid;grid-template-columns:120px 120px 140px;gap:8px}.control{background:linear-gradient(#101923,#0a1017);border:1px solid var(--line);border-radius:12px;padding:10px;text-align:center}.control label{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;margin-bottom:4px}.control input{width:100%;border:0;background:transparent;color:var(--blue);font-weight:900;font-size:1.18rem;text-align:center}.clock{font-weight:900;font-size:1.28rem;color:#fff}
.card{background:rgba(11,17,24,.94);border:1px solid var(--line);border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.28);overflow:hidden;margin-bottom:12px}.guard{padding:12px 14px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}.ok{color:var(--green)!important}.bad{color:var(--red)!important}
.fico{padding:14px 16px}.fico-grid{display:grid;grid-template-columns:1fr 230px;gap:14px}.fico label{display:block;color:var(--ink);font-weight:900;font-size:.82rem;margin-bottom:6px}textarea{width:100%;min-height:130px;background:#f9fbff;color:#111;border:1px solid #cfd7e2;border-radius:12px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88rem;line-height:1.25}.button-col{display:flex;flex-direction:column;gap:10px}
button{border:1px solid #244b78;border-radius:10px;padding:11px 12px;background:#0b1a2b;color:#74b9ff;font-weight:900;font-size:.92rem}button.primary{background:#111;color:#fff;border-color:#333}button.danger{border-color:#765025;color:#ffc400}.parse-note{margin-top:8px;color:var(--muted);font-size:.82rem;line-height:1.35}
.table-scroll{overflow-x:auto}table{width:100%;min-width:930px;border-collapse:collapse;font-size:.95rem}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;white-space:nowrap;vertical-align:middle}th{background:#111922;color:#c9d1d9;font-size:.78rem;font-weight:900}td{color:#eef3f8}
.badge{font-weight:900;border-radius:8px;display:inline-block;padding:3px 7px}.badge-green{background:rgba(65,212,90,.14);color:var(--green)}.badge-amber{background:rgba(255,196,0,.14);color:var(--amber)}.small{display:block;color:var(--muted);font-size:.72rem;margin-top:2px}
.status-planned{color:var(--green);font-weight:900}.status-delayed{color:var(--amber);font-weight:900}.status-safe{color:var(--green);font-weight:900}.status-unknown{color:var(--grey);font-weight:900}.row-safe{background:rgba(65,212,90,.06)}.row-pre{background:rgba(88,166,255,.07)}.row-live{background:rgba(255,196,0,.06)}.row-critical{background:rgba(255,75,75,.12)}.row-departed{background:rgba(255,255,255,.035)}
.dot{display:inline-block;width:18px;height:18px;border-radius:50%;vertical-align:-4px;box-shadow:inset 0 2px 3px rgba(255,255,255,.85),inset 0 -3px 5px rgba(0,0,0,.3),0 1px 4px rgba(0,0,0,.5)}.dot-green{background:linear-gradient(#83ff83,#0cad2a)}.dot-amber{background:linear-gradient(#ffd56a,#ff9800)}.dot-red{background:linear-gradient(#ff7777,#d60000)}.dot-blue{background:linear-gradient(#7db7ff,#1b64d8)}.dot-grey{background:linear-gradient(#eee,#9aa3ad)}
.checks{display:flex;gap:6px}.check-link{display:inline-block;text-decoration:none;background:#05080c;border:1px solid #244b78;padding:5px 7px;border-radius:7px;font-size:.78rem;font-weight:900;line-height:1}.check-link.ba{color:#fff;border-color:#555}.check-link.lhr{color:#d8b4ff;border-color:#5b3f85}.check-link.fa{color:#74b9ff;border-color:#244b78}
.legend{display:flex;gap:18px;flex-wrap:wrap;padding:11px 14px;color:#c9d1d9;font-size:.88rem}.legend span{display:inline-flex;gap:7px;align-items:center}.note{padding:12px 14px;color:var(--muted);font-size:.82rem;border-top:1px solid var(--line)}
.errorbox{display:none;padding:10px 14px;border:1px solid rgba(255,75,75,.5);background:rgba(255,75,75,.08);border-radius:12px;margin-bottom:12px;color:#ffb8b8}
@media(max-width:800px){.header{grid-template-columns:1fr}.controls{grid-template-columns:1fr 1fr 1fr}.fico-grid{grid-template-columns:1fr}table{font-size:.9rem;min-width:900px}.guard{grid-template-columns:1fr}}
</style>
</head>
<body>
<main class="app">
<section class="header">
  <div><h1>HSB Reserve App <span class="version">v15</span></h1><p class="sub">All times in Zulu (Z). Manual FlightAware refresh only. Monthly app cap: $8.</p></div>
  <div class="controls"><div class="control"><label for="hsbStart">HSB start</label><input id="hsbStart" type="time" value="12:00"></div><div class="control"><label for="hsbEnd">HSB finish</label><input id="hsbEnd" type="time" value="20:00"></div><div class="control"><label>UTC</label><div class="clock" id="utcClock">----Z</div></div></div>
</section>
<div id="errorBox" class="errorbox"></div>
<section class="card guard"><div id="usageGuard">Loading usage guard...</div><div><button id="usageBtn">Check usage</button></div></section>
<section class="card fico"><div class="fico-grid"><div><label for="ficoInput">Paste BA/FICO flight list</label><textarea id="ficoInput" spellcheck="false">${esc(DEFAULT_FICO)}</textarea></div><div class="button-col"><button class="primary" id="parseBtn">Parse FICO list</button><button class="danger" id="statusBtn">Refresh live status</button><div id="parseNote" class="parse-note">No automatic paid polling.</div></div></div></section>
<section class="card">
  <div class="table-scroll"><table><thead><tr><th></th><th>Flight</th><th>Route</th><th>T/O</th><th>Arr</th><th>Block</th><th>Call by</th><th>Status</th><th>Countdown</th><th>Checks</th></tr></thead><tbody id="rows"></tbody></table></div>
  <div class="legend"><span><i class="dot dot-green"></i> Safe</span><span><i class="dot dot-amber"></i> Still callable</span><span><i class="dot dot-red"></i> Action required</span><span><i class="dot dot-blue"></i> HSB not started</span><span><i class="dot dot-grey"></i> Unknown</span></div>
  <div class="note">Call by = earlier of latest legal call time or HSB finish. Departed and Cancelled both show green because both are operationally safe. BA/LHR/FA open external checks.</div>
</section>
</main>
<script>
(function(){
"use strict";

var flights = [];
var statuses = {};
var usageGuard = null;
var HSB_TO_CHOCKS_LIMIT = 1140;
var CALL_BEFORE_TAKEOFF = 120;
var COST_PER_FLIGHT_USD = 0.005;
var STORAGE_KEY = "hsb-reserve-fico-v15";

function byId(id){ return document.getElementById(id); }
function showError(msg){ var el = byId("errorBox"); if(el){ el.style.display = "block"; el.textContent = msg; } }
function money(n){ return "$" + Number(n || 0).toFixed(3); }
function toMin(t){ var p = t.split(":").map(Number); return p[0] * 60 + p[1]; }
function digitsOnly(s){ return String(s || "").split("").filter(function(c){ return c >= "0" && c <= "9"; }).join(""); }
function compactToMin(s){ s = digitsOnly(s).padStart(4, "0"); return Number(s.slice(0,2))*60 + Number(s.slice(2,4)); }
function minToBlock(mins){ mins = Math.abs(mins); return String(Math.floor(mins/60)).padStart(2,"0") + ":" + String(mins%60).padStart(2,"0"); }
function fmt(mins){ var plus = mins >= 1440 ? " +1" : ""; mins = ((mins % 1440) + 1440) % 1440; return String(Math.floor(mins/60)).padStart(2,"0") + String(mins%60).padStart(2,"0") + "Z" + plus; }
function fmtShort(mins){ return fmt(mins).replace("Z",""); }
function dur(mins){ mins = Math.max(0, Math.abs(mins)); return Math.floor(mins/60) + "h " + String(mins%60).padStart(2,"0") + "m"; }
function utcNowMinutes(){ var d = new Date(); return d.getUTCHours()*60 + d.getUTCMinutes(); }
function utcNowText(){ var d = new Date(); return String(d.getUTCHours()).padStart(2,"0") + String(d.getUTCMinutes()).padStart(2,"0") + "Z"; }
function futureDelta(targetMins, nowMins){ var target = targetMins; while(target < nowMins - 720) target += 1440; return target - nowMins; }
function normaliseEnd(start,end){ return end <= start ? end + 1440 : end; }

function parseFico(text){
  var parsed = [];
  var lines = String(text || "").split(String.fromCharCode(10));
  for (var i=0; i<lines.length; i++){
    var line = lines[i].trim();
    if (!line) continue;
    var parts = line.split(" ").filter(function(x){ return x.length > 0; });
    if (parts.length < 6) continue;
    if (parts[0].indexOf("/") !== -1) continue;
    if (digitsOnly(parts[0]).length !== 3) continue;
    if (parts[1].indexOf("-") === -1) continue;
    var routeParts = parts[1].split("-");
    if (routeParts.length !== 2) continue;
    var flight = "BA" + digitsOnly(parts[0]);
    var schedTO = compactToMin(parts[2]);
    var schedArr = compactToMin(parts[5]);
    if (schedArr <= schedTO) schedArr += 1440;
    parsed.push({ flight: flight, from: routeParts[0], to: routeParts[1], route: parts[1], schedTO: schedTO, schedArr: schedArr, block: schedArr - schedTO });
  }
  return parsed.sort(function(a,b){ return a.schedTO - b.schedTO; });
}

async function checkUsage(){
  try {
    var res = await fetch("/api/usage", { cache: "no-store" });
    var data = await res.json();
    usageGuard = data;
    if (!data.ok) {
      byId("usageGuard").innerHTML = "<strong class='bad'>AeroAPI blocked:</strong> " + (data.error || "usage guard unavailable");
      return;
    }
    byId("usageGuard").innerHTML = "<strong class='ok'>AeroAPI guard active.</strong> Used this month: <strong>" + money(data.used_usd) + "</strong> / $" + Number(data.cap_usd).toFixed(2) + ". Remaining: <strong>" + money(data.remaining_usd) + "</strong>. Calls: <strong>" + data.calls + "</strong>. Cache: " + Math.round(data.cache_ttl_seconds/60) + " min.";
  } catch(e) {
    usageGuard = null;
    byId("usageGuard").innerHTML = "<strong class='bad'>AeroAPI blocked:</strong> usage check failed.";
    showError("Usage check failed: " + String(e));
  }
}

async function refreshStatus(){
  if (!flights.length) parseAndRender();
  await checkUsage();
  if (!usageGuard || !usageGuard.ok) {
    byId("parseNote").textContent = "Live refresh blocked: usage guard unavailable.";
    return;
  }
  var estimated = flights.length * COST_PER_FLIGHT_USD;
  var ok = confirm("Refresh live status for " + flights.length + " flights? Estimated maximum cost " + money(estimated) + ". Cached results may cost less. Monthly app cap is $" + Number(usageGuard.cap_usd).toFixed(2) + ".");
  if (!ok) {
    byId("parseNote").textContent = "Live refresh cancelled. No AeroAPI calls made.";
    return;
  }
  try {
    var query = flights.map(function(f){ return f.flight; }).join(",");
    var res = await fetch("/api/status?flights=" + encodeURIComponent(query), { cache: "no-store" });
    var data = await res.json();
    if (!data.ok) {
      byId("parseNote").textContent = "Live refresh blocked/error: " + (data.error || "unknown");
      if (data.error) showError(data.error);
      return;
    }
    statuses = data.flights || {};
    byId("parseNote").textContent = "Updated: " + new Date(data.updated).toUTCString() + ". Paid calls: " + data.paid_calls_this_refresh + ". Cost: " + money(data.estimated_cost_this_refresh_usd) + ". Used this month: " + money(data.used_usd) + ".";
    await checkUsage();
    render();
  } catch(e) {
    byId("parseNote").textContent = "Live status fetch failed: " + String(e);
    showError("Live status fetch failed: " + String(e));
  }
}

function parseAndRender(){
  var text = byId("ficoInput").value;
  localStorage.setItem(STORAGE_KEY, text);
  flights = parseFico(text);
  statuses = {};
  byId("parseNote").textContent = "Parsed " + flights.length + " flights. Estimated max refresh cost: " + money(flights.length * COST_PER_FLIGHT_USD) + ".";
  render();
}

function computeRows(){
  var startInput = byId("hsbStart").value;
  var endInput = byId("hsbEnd").value;
  if (!startInput || !endInput) return null;
  var hsbStart = toMin(startInput);
  var hsbEnd = normaliseEnd(hsbStart, toMin(endInput));
  var latestOnBlocks = hsbStart + HSB_TO_CHOCKS_LIMIT;
  var now = utcNowMinutes();
  var hsbStartDelta = futureDelta(hsbStart, now);
  var hsbFinishDelta = futureDelta(hsbEnd, now);
  var hsbNotStarted = hsbStartDelta > 0 && hsbStartDelta < 720;
  var hsbFinished = hsbFinishDelta < 0;
  var rows = flights.map(function(f){
    var latestTO = latestOnBlocks - f.block;
    var latestCall = latestTO - CALL_BEFORE_TAKEOFF;
    var callBy = Math.min(latestCall, hsbEnd);
    var callByReason = hsbEnd < latestCall ? "HSB finish" : "Latest call";
    var delta = futureDelta(callBy, now);
    var fs = statuses[f.flight] || { status:"no_live_refresh", found:false, label:null, safe_by_status:false };
    return Object.assign({}, f, { latestOnBlocks:latestOnBlocks, latestTO:latestTO, latestCall:latestCall, callBy:callBy, callByReason:callByReason, delta:delta, fs:fs });
  });
  return { rows:rows, hsbStart:hsbStart, hsbEnd:hsbEnd, latestOnBlocks:latestOnBlocks, now:now, hsbStartDelta:hsbStartDelta, hsbFinishDelta:hsbFinishDelta, hsbNotStarted:hsbNotStarted, hsbFinished:hsbFinished };
}

function apiHasUsefulStatus(f){ return f.fs && f.fs.found && f.fs.label && f.fs.label !== "Unknown"; }
function operationalStatus(f,state){
  if (f.fs && f.fs.safe_by_status) return f.fs.label || "Departed";
  if (state.hsbFinished || f.delta < 0) return "Safe";
  if (apiHasUsefulStatus(f)) return f.fs.label;
  if (state.now >= f.schedTO) return "Delayed";
  return "Planned";
}
function isSafe(f,state){ return (f.fs && f.fs.safe_by_status) || state.hsbFinished || f.delta < 0; }
function dotClassFor(f,state){ if(state.hsbNotStarted)return"dot-blue"; if(isSafe(f,state))return"dot-green"; if(operationalStatus(f,state)==="Unknown")return"dot-grey"; if(f.delta<=30)return"dot-red"; return"dot-amber"; }
function rowClassFor(f,state){ if(state.hsbNotStarted)return"row-pre"; if(isSafe(f,state))return f.fs && f.fs.safe_by_status ? "row-departed" : "row-safe"; if(f.delta<=30)return"row-critical"; return"row-live"; }
function statusClass(f,state){ var s=operationalStatus(f,state); if(s==="Planned")return"status-planned"; if(s==="Delayed")return"status-delayed"; if(s==="Safe"||s==="Departed"||s==="Cancelled"||s==="Diverted")return"status-safe"; if(s==="Unknown")return"status-unknown"; return"status-live"; }
function countdownText(f,state){ if(state.hsbNotStarted)return"HSB starts "+dur(state.hsbStartDelta); if(isSafe(f,state))return"Safe"; return dur(f.delta)+" left"; }

function todayIso(){ return new Date().toISOString().slice(0,10); }
function flightNumberOnly(flight){ return digitsOnly(String(flight || "").startsWith("BA") ? String(flight).slice(2) : flight); }
function baStatusUrl(flight){ return "https://www.britishairways.com/travel/flightstatus/public/en_us/results/loaded?searchMethod=flight&date=" + todayIso() + "&isDepartures=true&flightNumber=" + encodeURIComponent(flightNumberOnly(flight)); }
function lhrStatusUrl(flight){ return "https://www.heathrow.com/departures/terminal-5/flight-details/" + encodeURIComponent(flight); }
function flightAwarePublicUrl(flight){ var raw = flightNumberOnly(flight); var num = raw.replace(/^0+/, "") || raw; return "https://uk.flightaware.com/live/flight/BAW" + encodeURIComponent(num); }
function checksHtml(flight){ return "<div class='checks'><a class='check-link ba' target='_blank' rel='noopener' href='" + baStatusUrl(flight) + "'>BA</a><a class='check-link lhr' target='_blank' rel='noopener' href='" + lhrStatusUrl(flight) + "'>LHR</a><a class='check-link fa' target='_blank' rel='noopener' href='" + flightAwarePublicUrl(flight) + "'>FA</a></div>"; }

function render(){
  byId("utcClock").textContent = utcNowText();
  var state = computeRows();
  if (!state) return;
  var rowsEl = byId("rows");
  rowsEl.innerHTML = "";
  for (var i=0; i<state.rows.length; i++){
    var f = state.rows[i];
    var callBadge = isSafe(f,state) ? "badge-green" : "badge-amber";
    var tr = document.createElement("tr");
    tr.className = rowClassFor(f,state);
    tr.innerHTML =
      "<td><span class='dot " + dotClassFor(f,state) + "'></span></td>" +
      "<td><strong>" + f.flight + "</strong></td>" +
      "<td>" + f.route + "</td>" +
      "<td>" + fmtShort(f.schedTO) + "</td>" +
      "<td>" + fmtShort(f.schedArr) + "</td>" +
      "<td>" + minToBlock(f.block) + "</td>" +
      "<td><span class='badge " + callBadge + "'>" + fmt(f.callBy) + "</span><span class='small'>" + f.callByReason + "</span></td>" +
      "<td class='" + statusClass(f,state) + "'>" + operationalStatus(f,state) + "</td>" +
      "<td>" + countdownText(f,state) + "</td>" +
      "<td>" + checksHtml(f.flight) + "</td>";
    rowsEl.appendChild(tr);
  }
}

function start(){
  byId("parseBtn").addEventListener("click", parseAndRender);
  byId("statusBtn").addEventListener("click", refreshStatus);
  byId("usageBtn").addEventListener("click", checkUsage);
  byId("hsbStart").addEventListener("input", render);
  byId("hsbEnd").addEventListener("input", render);
  var saved = localStorage.getItem(STORAGE_KEY);
  if (saved) byId("ficoInput").value = saved;
  parseAndRender();
  checkUsage();
  setInterval(render, 10000);
}

try { start(); }
catch(e) { showError("Frontend startup error: " + String(e)); byId("utcClock").textContent = "ERROR"; }
})();
</script>
</body>
</html>`;
}
