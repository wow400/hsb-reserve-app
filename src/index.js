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
    if (url.pathname === "/api/session") return handleSession(request, env);
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
    version: "v42",
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
    version: "v42",
    month: monthKey(),
    cap_usd: MONTHLY_CAP_USD,
    used_usd: usage.cost_usd,
    calls: usage.calls,
    remaining_usd: roundMoney(Math.max(0, MONTHLY_CAP_USD - usage.cost_usd)),
    cost_per_flight_usd: COST_PER_FLIGHT_USD,
    cache_ttl_seconds: CACHE_TTL_SECONDS
  });
}

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function sessionKey() {
  return "session:" + utcDateKey();
}

async function handleSession(request, env) {
  if (!env.USAGE_KV) {
    return json({ ok: false, error: "Missing USAGE_KV binding" }, 500);
  }

  if (request.method === "GET") {
    const stored = await env.USAGE_KV.get(sessionKey(), "json");
    if (!stored || stored.date !== utcDateKey() || !stored.session) {
      return json({ ok: true, version: "v42", date: utcDateKey(), session: null });
    }
    return json({
      ok: true,
      version: "v42",
      date: utcDateKey(),
      saved_at: stored.saved_at || null,
      session: stored.session
    });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || !body.session || typeof body.session !== "object") {
      return json({ ok: false, error: "Missing session object" }, 400);
    }

    const session = body.session;
    const encoded = JSON.stringify(session);
    if (encoded.length > 100000) {
      return json({ ok: false, error: "Session snapshot too large" }, 413);
    }

    const ficoText = typeof session.ficoText === "string" ? session.ficoText.slice(0, 20000) : "";
    const hsbStart = typeof session.hsbStart === "string" && /^\d{2}:\d{2}$/.test(session.hsbStart) ? session.hsbStart : "12:00";
    const hsbEnd = typeof session.hsbEnd === "string" && /^\d{2}:\d{2}$/.test(session.hsbEnd) ? session.hsbEnd : "20:00";
    const flights = Array.isArray(session.flights) ? session.flights.slice(0, 100) : [];
    const statuses = session.statuses && typeof session.statuses === "object" ? session.statuses : {};
    const lastLiveRefreshAt = Number.isFinite(Number(session.lastLiveRefreshAt)) ? Number(session.lastLiveRefreshAt) : null;
    const nowIso = new Date().toISOString();

    const clean = {
      date: utcDateKey(),
      ficoText,
      hsbStart,
      hsbEnd,
      flights,
      statuses,
      lastLiveRefreshAt,
      clientSavedAt: typeof session.clientSavedAt === "string" ? session.clientSavedAt : null
    };

    await env.USAGE_KV.put(sessionKey(), JSON.stringify({
      date: utcDateKey(),
      saved_at: nowIso,
      session: clean
    }), { expirationTtl: 60 * 60 * 24 * 3 });

    return json({ ok: true, version: "v42", date: utcDateKey(), saved_at: nowIso });
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
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

  const meta = {};
  try {
    const metaParam = url.searchParams.get("meta");
    if (metaParam) {
      const parsedMeta = JSON.parse(metaParam);
      if (parsedMeta && typeof parsedMeta === "object") {
        for (const [k, v] of Object.entries(parsedMeta)) meta[String(k).toUpperCase()] = v;
      }
    }
  } catch (_) {}

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
      const mapped = mapAeroFlight(flight, data, meta[flight] || null);
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
    version: "v42",
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

function mapAeroFlight(requestedFlight, data, expectedMeta) {
  const list = Array.isArray(data && data.flights) ? data.flights : [];
  const best = pickBestRecord(requestedFlight, list, expectedMeta);
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

function pickBestRecord(requestedFlight, list, expectedMeta) {
  if (!list.length) return null;
  const targetDate = expectedMeta && expectedMeta.serviceDate ? String(expectedMeta.serviceDate) : new Date().toISOString().slice(0, 10);
  const reqNum = requestedFlight.startsWith("BA") ? requestedFlight.slice(2).replace(/^0+/, "") : requestedFlight;

  const candidates = list.filter(item => {
    const ident = String(item.ident || item.ident_iata || "").replace(/\s+/g, "").toUpperCase();
    const identNum = ident.replace(/^BAW/i, "").replace(/^BA/i, "").replace(/^0+/, "");
    return !ident || ident === requestedFlight || identNum === reqNum;
  });

  let usable = candidates.length ? candidates : list;

  if (expectedMeta && expectedMeta.from && expectedMeta.to) {
    const from = String(expectedMeta.from).toUpperCase();
    const to = String(expectedMeta.to).toUpperCase();
    const routed = usable.filter(item => {
      const origin = String((item.origin && (item.origin.code_iata || item.origin.code || item.origin.airport_code)) || "").toUpperCase();
      const dest = String((item.destination && (item.destination.code_iata || item.destination.code || item.destination.airport_code)) || "").toUpperCase();
      return (!origin || origin === from) && (!dest || dest === to);
    });
    if (routed.length) usable = routed;
  }

  const todayish = usable.filter(item => {
    const t = item.scheduled_out || item.estimated_out || item.actual_out || item.scheduled_off || item.estimated_off || item.actual_off;
    return t && String(t).slice(0, 10) === targetDate;
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

  const departedEvidence = Boolean(f.actual_off || f.actual_on || f.actual_in);
  if (departedEvidence || s.includes("departed") || s.includes("airborne") || s.includes("en route") || s.includes("enroute") || s.includes("arrived") || s.includes("landed")) {
    return { status: "departed", label: "Departed", safe_by_status: true, confidence: "confirmed" };
  }

  const scheduled = Date.parse(f.scheduled_out || f.scheduled_off || "");
  const estimated = Date.parse(f.estimated_out || f.estimated_off || "");
  const estimatedLate = scheduled && estimated && estimated > scheduled;

  // Do not infer a delay merely because STD has passed. Require explicit
  // AeroAPI delay status or a later estimated departure time.
  if (s.includes("delay") || estimatedLate) return { status: "delayed", label: "Delayed", safe_by_status: false, confidence: "aeroapi" };
  if (scheduled || s.includes("scheduled") || s.includes("planned")) return { status: "planned", label: "Planned", safe_by_status: false, confidence: "aeroapi" };

  return { status: "unknown", label: "Unknown", safe_by_status: false, confidence: "unknown" };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quarterHourOptions(selected) {
  let out = "";
  for (let m = 0; m < 1440; m += 15) {
    const value = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
    out += `<option value="${value}"${value === selected ? " selected" : ""}>${value}</option>`;
  }
  return out;
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
.controls{display:grid;grid-template-columns:120px 120px 140px;gap:8px}.control{background:linear-gradient(#101923,#0a1017);border:1px solid var(--line);border-radius:12px;padding:10px;text-align:center}.control label{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;margin-bottom:4px}.control input,select{width:100%;border:0;background:transparent;color:var(--blue);font-weight:900;font-size:1.18rem;text-align:center}.clock{font-weight:900;font-size:1.28rem;color:#fff}
.card{background:rgba(11,17,24,.94);border:1px solid var(--line);border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.28);overflow:hidden;margin-bottom:12px}.guard{padding:12px 14px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}.ok{color:var(--green)!important}.bad{color:var(--red)!important}
.fico{padding:14px 16px}.fico-grid{display:grid;grid-template-columns:1fr 230px;gap:14px}.fico-label-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}.fico label{display:block;color:var(--ink);font-weight:900;font-size:.82rem;margin:0}.select-fico-btn{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--muted);padding:2px 0;font-size:.76rem;font-weight:800;white-space:nowrap;cursor:pointer}.select-fico-btn:focus-visible{outline:2px solid var(--blue);outline-offset:4px;border-radius:6px}.select-fico-radio{width:15px;height:15px;border-radius:50%;border:2px solid #7f8b98;display:inline-block;position:relative;background:transparent;flex:0 0 auto}.select-fico-btn.selected{color:var(--blue)}.select-fico-btn.selected .select-fico-radio{border-color:var(--blue)}.select-fico-btn.selected .select-fico-radio:after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--blue)}textarea{width:100%;min-height:130px;background:#f9fbff;color:#111;border:1px solid #cfd7e2;border-radius:12px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88rem;line-height:1.25}.button-col{display:flex;flex-direction:column;gap:10px}
button{border:1px solid #244b78;border-radius:10px;padding:11px 12px;background:#0b1a2b;color:#74b9ff;font-weight:900;font-size:.92rem}button.primary{background:#111;color:#fff;border-color:#333}button.danger{border-color:#765025;color:#ffc400}button:disabled{opacity:.72;cursor:wait}.refresh-spinner{display:inline-block;width:14px;height:14px;margin-right:7px;border:2px solid rgba(255,196,0,.32);border-top-color:#ffc400;border-radius:50%;vertical-align:-2px;animation:refresh-spin .75s linear infinite}@keyframes refresh-spin{to{transform:rotate(360deg)}}.parse-note{margin-top:8px;color:var(--muted);font-size:.82rem;line-height:1.35}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}table{width:100%;min-width:1040px;border-collapse:collapse;font-size:.88rem}th,td{border-bottom:1px solid var(--line);padding:7px 5px;text-align:left;white-space:nowrap;vertical-align:middle}.center{text-align:center}.route{font-weight:900}.call-by-btn{border:0;cursor:pointer;font:inherit;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}th{background:#111922;color:#c9d1d9;font-size:.73rem;font-weight:900}td{color:#eef3f8}
.badge{font-weight:900;border-radius:8px;display:inline-block;padding:3px 7px}.badge-green{background:rgba(65,212,90,.14);color:var(--green)}.badge-amber{background:rgba(255,196,0,.14);color:var(--amber)}.small{display:block;color:var(--muted);font-size:.72rem;margin-top:2px}
.status-planned{color:var(--amber);font-weight:900}.status-delayed{color:var(--amber);font-weight:900}.status-action{color:var(--red);font-weight:900}.status-safe{color:var(--green);font-weight:900}.status-unknown{color:var(--grey);font-weight:900}.row-safe{background:rgba(65,212,90,.06)}.row-pre{background:rgba(88,166,255,.07)}.row-live{background:rgba(255,196,0,.06)}.row-critical{background:rgba(255,75,75,.12)}.row-departed{background:rgba(255,255,255,.035)}
.dot{display:inline-block;width:18px;height:18px;border-radius:50%;vertical-align:-4px;box-shadow:inset 0 2px 3px rgba(255,255,255,.85),inset 0 -3px 5px rgba(0,0,0,.3),0 1px 4px rgba(0,0,0,.5)}.dot-green{background:linear-gradient(#83ff83,#0cad2a)}.dot-amber{background:linear-gradient(#ffd56a,#ff9800)}.dot-red{background:linear-gradient(#ff7777,#d60000)}.dot-blue{background:linear-gradient(#7db7ff,#1b64d8)}.dot-grey{background:linear-gradient(#eee,#9aa3ad)}
.checks{display:flex;gap:6px}.check-link{display:inline-block;text-decoration:none;background:#05080c;border:1px solid #244b78;padding:5px 7px;border-radius:7px;font-size:.78rem;font-weight:900;line-height:1}.check-link.ba{color:#fff;border-color:#555}.check-link.lhr{color:#d8b4ff;border-color:#5b3f85}.check-link.fa{color:#74b9ff;border-color:#244b78}
.legend{display:flex;gap:14px;flex-wrap:wrap;padding:10px 12px;color:#c9d1d9;font-size:.82rem}.legend span{display:inline-flex;gap:6px;align-items:center}.note{padding:10px 12px;color:var(--muted);font-size:.78rem;border-top:1px solid var(--line);line-height:1.35}
.errorbox{display:none;padding:10px 14px;border:1px solid rgba(255,75,75,.5);background:rgba(255,75,75,.08);border-radius:12px;margin-bottom:12px;color:#ffb8b8}
.crew-detail-row td{padding:0 8px 8px;border-bottom:1px solid var(--line);white-space:normal}.crew-detail{margin:7px 0 0;padding:11px 13px;background:#f7f8fb;color:#111;border-radius:12px;border:1px solid #cfd7e2;line-height:1.35;white-space:pre-line;position:relative}.crew-detail-close{position:absolute;right:9px;top:8px;border:0;background:transparent;color:#1677c8;padding:4px 7px;font-size:.84rem}.crew-detail-text{padding-right:48px}.limiting-rule{margin:8px 48px 8px 0;padding:8px 10px;border:1px solid #d6aa00;border-radius:8px;background:#fff1ad;color:#111;font-weight:900}
@media(max-width:800px){body{padding:7px}.app{padding-top:4px}.header{grid-template-columns:1fr;gap:8px;margin-bottom:8px}h1{font-size:1.42rem}.sub{font-size:.82rem;line-height:1.3}.controls{grid-template-columns:1fr 1fr 1fr;gap:5px}.control{padding:7px 5px}.control label{font-size:.62rem}.control input,select{font-size:1rem}.clock{font-size:1.08rem}.fico{padding:10px}.fico-grid{grid-template-columns:1fr;gap:9px}textarea{min-height:92px;font-size:.74rem;padding:8px}.select-fico-btn{font-size:.7rem}.select-fico-radio{width:14px;height:14px}.button-col{gap:8px}button{padding:10px;font-size:.86rem}.parse-note{font-size:.74rem;margin-top:2px}.guard{grid-template-columns:1fr}.table-scroll{margin:0}table{font-size:.76rem;min-width:1000px}th,td{padding:6px 4px}th{font-size:.66rem}.dot{width:15px;height:15px}.checks{gap:4px}.check-link{padding:4px 5px;font-size:.7rem}.badge{padding:2px 5px}.legend{gap:10px;padding:9px 10px;font-size:.74rem}.note{font-size:.72rem;padding:9px 10px}}
@media(max-width:480px){body{padding:5px}.controls{gap:4px}.control{padding:6px 3px}.fico{padding:8px}textarea{min-height:82px}.table-scroll{border-top:1px solid var(--line)}table{font-size:.72rem;min-width:960px}th,td{padding:5px 3px}.legend{gap:8px}.legend .dot{width:14px;height:14px}}

.live-badge{display:inline-block;margin-left:8px;padding:2px 7px;border-radius:999px;background:rgba(65,212,90,.14);border:1px solid rgba(65,212,90,.55);color:#41d45a;font-size:.72rem;font-weight:900;vertical-align:2px}
.calls-green{color:#41d45a;font-weight:900}.calls-amber{color:#ffc400;font-weight:900}.calls-red{color:#ff4b4b;font-weight:900}.cache-note{color:#a8b0bb}

</style>
</head>
<body>
<main class="app">
<section class="header">
  <div><h1>HSB Reserve App <span class="version">v42</span></h1><p class="sub">All times in Zulu (Z). Manual FlightAware refresh only. Monthly app cap: $8.</p><p class="sub" id="headerUsage">AeroAPI guard loading...</p><p class="sub" id="liveLine">Not refreshed</p></div>
  <div><div class="controls"><div class="control"><label for="hsbStart">HSB start</label><select id="hsbStart">${quarterHourOptions("12:00")}</select></div><div class="control"><label for="hsbEnd">HSB finish</label><select id="hsbEnd">${quarterHourOptions("20:00")}</select></div><div class="control"><label>UTC</label><div class="clock" id="utcClock">----Z</div></div></div><p class="sub" style="text-align:right;margin-top:8px"><strong>A380 FICO departures: DP LHR a8</strong></p></div>
</section>
<div id="errorBox" class="errorbox"></div>
<section class="card guard" style="display:none"><div id="usageGuard">Loading usage guard...</div><div><button id="usageBtn">Check usage</button></div></section>
<section class="card fico"><div class="fico-grid"><div><div class="fico-label-row"><label for="ficoInput">Paste BA/FICO flight list</label><button type="button" id="selectFicoBtn" class="select-fico-btn" aria-label="Select all FICO text" title="Select all FICO text"><span class="select-fico-radio" aria-hidden="true"></span><span>Select all</span></button></div><textarea id="ficoInput" spellcheck="false">${esc(DEFAULT_FICO)}</textarea></div><div class="button-col"><button class="primary" id="parseBtn">Parse FICO list</button><button class="danger" id="statusBtn">Refresh live status</button><div id="parseNote" class="parse-note">No automatic paid polling.</div></div></div></section>
<section class="card">
  <div class="table-scroll"><table><thead><tr><th></th><th>Flight</th><th>Route</th><th class="center">2hrs b4 Report</th><th>Report</th><th>T/O</th><th>Block</th><th>Call by</th><th>Status</th><th>Countdown</th><th>Checks</th></tr></thead><tbody id="rows"></tbody></table></div>
  <div class="legend"><span><i class="dot dot-green"></i> Safe</span><span><i class="dot dot-amber"></i> Still callable &gt;30m</span><span><i class="dot dot-red"></i> Call deadline ≤30m</span><span><i class="dot dot-blue"></i> HSB not started</span><span><i class="dot dot-grey"></i> Unknown / refresh</span></div>
  <div class="note">2hrs b4 Report = Heathrow local time (lower-case l), two hours before the original scheduled report. Report stays tied to the original rostered departure and does not move with delays/revised ETDs. Report/T/O are Zulu. Call by = latest useful contact time after the original/augmented crew BLR limit, your Scheme/OM A HSB limit, BLR 19h limit, two-hour travel time and HSB finish are all applied. For these six A380 trips the app uses BLR Box A for 2 crew, Box C (+3h) for 3 crew and Box D to Scheme for 4 crew; BLR FDP includes the 30-minute clear after arrival. Tap Call by to open the FDP detail for that flight; the rule that actually limits Call by is highlighted. Green = safe/no longer callable. Amber = still callable with more than 30m remaining. Red = call deadline within 30m. Grey = live status unknown or refresh needed. Delay/New ETD is shown separately in Status. BA/LHR/FA open external checks.</div>
</section>
</main>
<script>
(function(){
"use strict";

var flights = [];
var statuses = {};
var usageGuard = null;
var lastLiveRefreshAt = null;
var selectedCrewFlight = null;
var HSB_TO_CHOCKS_LIMIT = 1140;
var CANNOT_COVER_AFTER_HSB_START = 1140;
var CALL_BEFORE_TAKEOFF = 120;
var REPORT_BEFORE_TAKEOFF = 90;
var CALL_BEFORE_REPORT = 120;
var BLR_CLEAR_AFTER_ARRIVAL = 30;
// Original scheduled A380 T5 report times. These stay fixed even if FICO or
// FlightAware later shows a revised/delayed departure time.
var ORIGINAL_REPORT_BY_FLIGHT = {
  BA207: 7*60+25,
  BA285: 8*60+15,
  BA213: 12*60,
  BA269: 12*60+35,
  BA011: 16*60+55,
  BA057: 18*60+50
};
// Normal A380 operating flight-crew complements for this app. A380 rest is Class 1.
var A380_CREW_BY_FLIGHT = { BA207:3, BA285:3, BA213:2, BA269:3, BA011:4, BA057:3 };
var BLR_CONTINENTAL_US_DESTINATIONS = { MIA:true, SFO:true, BOS:true, LAX:true };
function baseFdpTwoPilot(report){
  var m=((report%1440)+1440)%1440;
  if(m>=6*60 && m<=13*60+29)return 13*60;
  if(m<=4*60+59 || m>=17*60)return 11*60;
  if(m>=13*60+30 && m<=13*60+59)return 12*60+45;
  if(m>=14*60 && m<=14*60+29)return 12*60+30;
  if(m>=14*60+30 && m<=14*60+59)return 12*60+15;
  if(m>=15*60 && m<=15*60+29)return 12*60;
  if(m>=15*60+30 && m<=15*60+59)return 11*60+45;
  if(m>=16*60 && m<=16*60+29)return 11*60+30;
  if(m>=16*60+30 && m<=16*60+59)return 11*60+15;
  if(m>=5*60 && m<=5*60+14)return 12*60;
  if(m>=5*60+15 && m<=5*60+29)return 12*60+15;
  if(m>=5*60+30 && m<=5*60+44)return 12*60+30;
  return 12*60+45;
}
function blrBoxAFdp(f,report){
  var local=londonLocalMinutesFromUtcMinutes(report);
  var continentalUs=!!BLR_CONTINENTAL_US_DESTINATIONS[f.to];
  if(local>=6*60 && local<=17*60+59)return 12*60;
  if(local>=18*60 && local<=21*60+59)return continentalUs ? 11*60+30 : 11*60;
  return continentalUs ? 10*60+30 : 10*60;
}
function blrFdpForCrew(boxA,crew,schemeFdp){
  if(crew===2)return Math.min(boxA,schemeFdp);
  if(crew===3)return Math.min(boxA+3*60,schemeFdp); // Box C maximum.
  return schemeFdp; // Box D: above Box A +3h, capped by BA Scheme.
}
function blrBoxName(crew){ return crew===2 ? "Box A" : (crew===3 ? "Box C" : "Box D"); }
function crewInfo(f){
  var crew=A380_CREW_BY_FLIGHT[f.flight] || null;
  if(!crew)return null;
  var report=scheduledReportMins(f), maxFdp;
  if(crew===2) maxFdp=baseFdpTwoPilot(report);
  else if(crew===3) maxFdp=(f.block>9*60 ? 17*60 : 16*60);
  else maxFdp=(f.block>9*60 ? 18*60 : 17*60);
  var expiry=report+maxFdp;
  var latest=expiry-f.block;
  var augmentedCrew=Math.min(4,crew+1), augmentedFdp=maxFdp, augmentedLatest=latest;
  if(crew===2){ augmentedFdp=(f.block>9*60 ? 17*60 : 16*60); augmentedLatest=report+augmentedFdp-f.block; }
  else if(crew===3){ augmentedFdp=(f.block>9*60 ? 18*60 : 17*60); augmentedLatest=report+augmentedFdp-f.block; }

  // Industrial BLR limits. For these six A380 trips the agreed app mapping is:
  // 2 pilots = Box A; 3 pilots = Box C (Box A +3h); 4 pilots = Box D to Scheme.
  // BLR FDP runs to 30 minutes after arrival, hence the extra 30-minute clear.
  var boxA=blrBoxAFdp(f,report);
  var blrOriginalFdp=blrFdpForCrew(boxA,crew,maxFdp);
  var blrOriginalLatest=report+blrOriginalFdp-f.block-BLR_CLEAR_AFTER_ARRIVAL;
  var blrAugmentedFdp=blrFdpForCrew(boxA,augmentedCrew,augmentedFdp);
  var blrAugmentedLatest=report+blrAugmentedFdp-f.block-BLR_CLEAR_AFTER_ARRIVAL;
  var originalOperationalLatest=Math.min(latest,blrOriginalLatest);
  var originalLimiter=(blrOriginalLatest<=latest ? "BLR "+crew+" crew" : "Scheme / OM A");

  return {crew:crew,report:report,maxFdp:maxFdp,expiry:expiry,latest:latest,augmentedCrew:augmentedCrew,augmentedFdp:augmentedFdp,augmentedLatest:augmentedLatest,boxA:boxA,blrOriginalFdp:blrOriginalFdp,blrOriginalLatest:blrOriginalLatest,blrOriginalBox:blrBoxName(crew),blrAugmentedFdp:blrAugmentedFdp,blrAugmentedLatest:blrAugmentedLatest,blrAugmentedBox:blrBoxName(augmentedCrew),originalOperationalLatest:originalOperationalLatest,originalLimiter:originalLimiter};
}
function estimatedDepartureMins(f){
  if(!f.fs || !f.fs.found)return null;
  var iso=f.fs.estimated_out || f.fs.estimated_off || null;
  if(!iso)return null;
  var d=new Date(iso); if(isNaN(d.getTime()))return null;
  var m=d.getUTCHours()*60+d.getUTCMinutes();
  while(m < f.schedTO-720)m+=1440;
  return m;
}
function initialNightWindowEnd(hsbStart){
  var m=((hsbStart%1440)+1440)%1440;
  var dayBase=hsbStart-m;
  if(m<7*60)return dayBase+7*60;
  if(m>=23*60)return dayBase+1440+7*60;
  return null;
}
function countedHsbForScheme(hsbStart,reportTime,contactTime){
  var elapsed=Math.max(0,reportTime-hsbStart);
  var nightEnd=initialNightWindowEnd(hsbStart);
  if(nightEnd===null)return elapsed;
  // OM A 7.14.2(v)(d): when HSB starts 2300-0700, the part of that
  // initial 2300-0700 window before BA contacts the pilot does not count
  // towards the HSB FDP reduction.
  var excluded=Math.max(0,Math.min(contactTime,nightEnd)-hsbStart);
  return Math.max(0,elapsed-excluded);
}
function schemeLatestDepartureForHsb(f,ci,hsbStart,hsbEnd){
  if(!ci)return null;
  var latest=null;
  // We use the agreed app convention: two hours from call to LHR, and for
  // this capability calculation arrival/report at LHR is treated as the
  // earliest departure point. Augmented A380 duties use in-flight rest, so
  // the HSB reduction threshold is 8 hours (OM A 7.14.2(v)(c)).
  var firstPossible=hsbStart+CALL_BEFORE_TAKEOFF;
  var searchEnd=hsbStart+36*60;
  for(var departure=firstPossible;departure<=searchEnd;departure++){
    var latestContact=Math.min(departure-CALL_BEFORE_TAKEOFF,hsbEnd);
    if(latestContact<hsbStart)continue;
    var countedStandby=countedHsbForScheme(hsbStart,departure,latestContact);
    var reduction=Math.max(0,countedStandby-8*60);
    var availableFdp=ci.augmentedFdp-reduction;
    if(f.block<=availableFdp)latest=departure;
  }
  return latest;
}
function hsbAugmentationInfo(f,ci,hsbStart,hsbEnd){
  if(!ci)return null;
  var blrLatest=hsbStart+HSB_TO_CHOCKS_LIMIT-f.block;
  var schemeLatest=schemeLatestDepartureForHsb(f,ci,hsbStart,hsbEnd);
  if(schemeLatest===null)schemeLatest=-999999;
  if(ci.crew===4){
    // A fifth pilot does not increase the operating crew category. If the
    // HSB pilot is replacing sickness, the existing 4-crew BLR/Scheme limit,
    // their own HSB Scheme limit and the HSB 19h envelope all still apply.
    var replacementLatest=Math.min(ci.originalOperationalLatest,schemeLatest,blrLatest);
    var replacementLimiter=ci.originalLimiter;
    var replacementMin=replacementLatest;
    if(replacementMin===blrLatest)replacementLimiter="BLR 19h";
    else if(replacementMin===schemeLatest)replacementLimiter="Scheme / OM A";
    return {crewLatest:ci.originalOperationalLatest,schemeLatest:schemeLatest,blrLatest:blrLatest,blrCrewLatest:ci.blrOriginalLatest,usableLatest:replacementLatest,extension:0,limiter:replacementLimiter};
  }
  var augmentedCrewLimit=Math.min(ci.augmentedLatest,ci.blrAugmentedLatest);
  var augmentedCrewLimiter=(ci.blrAugmentedLatest<=ci.augmentedLatest ? ci.augmentedCrew+" crew BLR" : ci.augmentedCrew+" crew Scheme");
  var usableLatest=Math.min(augmentedCrewLimit,schemeLatest,blrLatest);
  var extension=Math.max(0,usableLatest-ci.originalOperationalLatest);
  var limiter=augmentedCrewLimiter;
  var minVal=usableLatest;
  if(minVal===blrLatest)limiter="BLR 19h";
  else if(minVal===schemeLatest)limiter="Scheme / OM A";
  return {crewLatest:augmentedCrewLimit,schemeLatest:schemeLatest,blrLatest:blrLatest,blrCrewLatest:ci.blrAugmentedLatest,usableLatest:usableLatest,extension:extension,limiter:limiter};
}
function callabilityFromHsb(f,hsbStart,hsbEnd){
  var ci=crewInfo(f);
  var ai=hsbAugmentationInfo(f,ci,hsbStart,hsbEnd);
  var blrLatest=hsbStart+HSB_TO_CHOCKS_LIMIT-f.block;
  var usableDeparture=ai ? ai.usableLatest : blrLatest;
  var latestUsefulCall=usableDeparture-CALL_BEFORE_TAKEOFF;
  var callBy=Math.min(latestUsefulCall,hsbEnd);
  var departureLimiter=ai ? ai.limiter : "BLR 19h";
  var callLimiter=(hsbEnd<=latestUsefulCall ? "HSB finish" : departureLimiter);
  return {crewInfo:ci,augmentationInfo:ai,usableDeparture:usableDeparture,latestUsefulCall:latestUsefulCall,callBy:callBy,tooLate:callBy<hsbStart,callLimiter:callLimiter};
}
function crewDetailData(f,ci){
  var ai=f.augmentationInfo;
  var lines=[f.flight+" "+f.route+" — original crew "+ci.crew+" pilots",
    "Original report: "+fmt(ci.report),
    ci.crew+" crew Scheme max FDP: "+minToBlock(ci.maxFdp),
    ci.crew+" crew Scheme latest departure: "+fmt(ci.latest),
    "BLR "+ci.crew+" crew ("+ci.blrOriginalBox+") max FDP: "+minToBlock(ci.blrOriginalFdp),
    "BLR "+ci.crew+" crew latest departure: "+fmt(ci.blrOriginalLatest),
    "Original operating limit: "+fmt(ci.originalOperationalLatest)+" ("+ci.originalLimiter+")",
    "Block: "+minToBlock(f.block)];
  if(ci.crew===4){
    lines.push("Already 4 pilots — an additional HSB pilot does not extend the 4 crew limit.");
    if(ai){
      // The HSB pilot's personal Scheme ceiling is a separate standby-derived
      // constraint. Only show it when it actually limits the usable departure;
      // otherwise it is liable to be confused with the flight's 4-crew Scheme limit.
      if(ai.limiter==="Scheme / OM A") lines.push("HSB pilot personal Scheme ceiling: "+fmt(ai.schemeLatest));
      lines.push("HSB BLR 19h latest departure: "+fmt(ai.blrLatest));
    }
    lines.push("Usable FDP extension: 0m");
  }else if(ai){
    lines.push("With HSB pilot: "+ci.augmentedCrew+" pilots");
    lines.push(ci.augmentedCrew+" crew Scheme max FDP: "+minToBlock(ci.augmentedFdp));
    lines.push(ci.augmentedCrew+" crew Scheme latest departure: "+fmt(ci.augmentedLatest));
    lines.push(ci.augmentedCrew+" crew BLR ("+ci.blrAugmentedBox+") max FDP: "+minToBlock(ci.blrAugmentedFdp));
    lines.push(ci.augmentedCrew+" crew BLR latest departure: "+fmt(ci.blrAugmentedLatest));
    // Keep the standby-derived personal Scheme ceiling distinct from the
    // flight's crew-category Scheme limit, and only display it if it constrains.
    if(ai.limiter==="Scheme / OM A") lines.push("HSB pilot personal Scheme ceiling: "+fmt(ai.schemeLatest));
    lines.push("HSB BLR 19h latest departure: "+fmt(ai.blrLatest));
    if(ai.extension>0) lines.push("Usable FDP extension: +"+dur(ai.extension)+" → "+fmt(ai.usableLatest));
    else lines.push("Usable FDP extension: 0m — calling you adds no later departure capability.");
  }
  if(f.tooLateFromThisHsb){
    lines.push("Earliest HSB arrival: "+fmt(f.hsbStartForDetail+CALL_BEFORE_TAKEOFF)+" — later than the usable departure limit, so this flight cannot use you from this HSB.");
  }else{
    lines.push("Latest useful call: "+fmt(f.callBy)+" (includes 2h travel and HSB finish).");
  }
  var limiting;
  if(f.tooLateFromThisHsb){
    limiting="LIMITING: "+f.callLimiter+" → latest useful call "+fmt(f.callBy)+" is before HSB starts "+fmt(f.hsbStartForDetail);
  }else{
    limiting="LIMITING: "+f.callLimiter+" → Call by "+fmt(f.callBy);
  }
  return {text:lines.join("\\n"),limiting:limiting};
}
var COST_PER_FLIGHT_USD = 0.005;
var STORAGE_KEY = "hsb-reserve-fico-current";
var HSB_START_KEY = "hsb-reserve-hsb-start";
var HSB_END_KEY = "hsb-reserve-hsb-finish";
var DEPARTED_STORE_KEY = "hsb-reserve-confirmed-airborne-v1";
var SESSION_SAVE_DELAY_MS = 350;
var sessionReady = false;
var sessionSaveTimer = null;
var sessionSaveSerial = Promise.resolve();

function byId(id){ return document.getElementById(id); }
function showError(msg){ var el = byId("errorBox"); if(el){ el.style.display = "block"; el.textContent = msg; } }
function money(n){ return "$" + Number(n || 0).toFixed(3); }
function liveAgeText(){
  if (!lastLiveRefreshAt) return "Not refreshed";
  var secs = Math.max(0, Math.floor((Date.now() - lastLiveRefreshAt) / 1000));
  if (secs < 60) return "Live (fresh)";
  var mins = Math.floor(secs / 60);
  return "Live (cached " + mins + " min ago)";
}
function updateLiveLine(){
  var el = byId("liveLine");
  if (!el) return;
  if (!lastLiveRefreshAt) { el.textContent = "Not refreshed"; return; }
  var d = new Date(lastLiveRefreshAt);
  el.innerHTML = "<span class='live-badge'>LIVE</span> <span class='cache-note'>" + liveAgeText() + " — " + String(d.getUTCHours()).padStart(2,"0") + String(d.getUTCMinutes()).padStart(2,"0") + "Z</span>";
}
function toMin(t){ var p = t.split(":").map(Number); return p[0] * 60 + p[1]; }
function digitsOnly(s){ return String(s || "").split("").filter(function(c){ return c >= "0" && c <= "9"; }).join(""); }
function isoDateForDayOfMonth(day){
  var n=Number(day); if(!Number.isFinite(n)||n<1||n>31)return null;
  var now=new Date();
  var base=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  for(var off=0;off<=31;off++){
    var d=new Date(base+off*86400000);
    if(d.getUTCDate()===n)return d.toISOString().slice(0,10);
  }
  return null;
}
function serviceDateFromFlightToken(token){
  var raw=String(token||"").trim();
  var bits=raw.split("/");
  if(bits.length===1)return todayIso();
  if(bits.length!==2 || digitsOnly(bits[1])!==bits[1] || bits[1].length>2)return null;
  return isoDateForDayOfMonth(bits[1]);
}
function serviceDayOffsetDays(){
  if(!flights.length || !flights[0].serviceDate)return 0;
  var now=new Date();
  var today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  var target=Date.parse(flights[0].serviceDate+"T00:00:00Z");
  return Number.isFinite(target)?Math.round((target-today)/86400000):0;
}
function activeServiceDate(){ return flights.length && flights[0].serviceDate ? flights[0].serviceDate : todayIso(); }
function compactToMin(s){ s = digitsOnly(s).padStart(4, "0"); return Number(s.slice(0,2))*60 + Number(s.slice(2,4)); }
function minToBlock(mins){ mins = Math.abs(mins); return String(Math.floor(mins/60)).padStart(2,"0") + ":" + String(mins%60).padStart(2,"0"); }
function fmt(mins){ var plus = mins >= 1440 ? " +1" : ""; mins = ((mins % 1440) + 1440) % 1440; return String(Math.floor(mins/60)).padStart(2,"0") + String(mins%60).padStart(2,"0") + "Z" + plus; }
function fmtShort(mins){ return fmt(mins).replace("Z",""); }
function scheduledReportMins(f){
  if (f && Object.prototype.hasOwnProperty.call(ORIGINAL_REPORT_BY_FLIGHT, f.flight)) return ORIGINAL_REPORT_BY_FLIGHT[f.flight];
  return f.schedTO - REPORT_BEFORE_TAKEOFF;
}
function londonLocalMinutesFromUtcMinutes(mins){
  var now = new Date();
  var base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + serviceDayOffsetDays()*86400000;
  var d = new Date(base + mins * 60000);
  try {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone:"Europe/London", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(d);
    var hh = parts.find(function(p){ return p.type === "hour"; });
    var mm = parts.find(function(p){ return p.type === "minute"; });
    if (hh && mm) return Number(hh.value)*60 + Number(mm.value);
  } catch (_) {}
  return d.getUTCHours()*60 + d.getUTCMinutes();
}
function londonLocalCompactFromUtcMinutes(mins){
  var m=londonLocalMinutesFromUtcMinutes(mins);
  return String(Math.floor(m/60)).padStart(2,"0") + String(m%60).padStart(2,"0") + "l";
}
function twoHoursBeforeReportLocal(f){ return londonLocalCompactFromUtcMinutes(scheduledReportMins(f) - CALL_BEFORE_REPORT); }
function dur(mins){ mins = Math.max(0, Math.abs(mins)); return Math.floor(mins/60) + "h " + String(mins%60).padStart(2,"0") + "m"; }
function utcNowMinutes(){ var d = new Date(); return d.getUTCHours()*60 + d.getUTCMinutes() - serviceDayOffsetDays()*1440; }
function utcNowText(){ var d = new Date(); return String(d.getUTCHours()).padStart(2,"0") + String(d.getUTCMinutes()).padStart(2,"0") + "Z"; }
function futureDelta(targetMins, nowMins){ return targetMins - nowMins; }
function normaliseEnd(start,end){ return end <= start ? end + 1440 : end; }
function cannotCoverFromHsb(f, hsbStart){
  var arrival = f.schedArr;
  while (arrival < hsbStart) arrival += 1440;
  return (arrival - hsbStart) >= CANNOT_COVER_AFTER_HSB_START;
}

function isConfirmedAirborneOrBeyond(fs){
  if (!fs) return false;
  if (fs.actual_off || fs.actual_on || fs.actual_in) return true;
  var raw = String(fs.raw_status || "").toLowerCase();
  return raw.indexOf("airborne") !== -1 || raw.indexOf("en route") !== -1 || raw.indexOf("enroute") !== -1 || raw.indexOf("arrived") !== -1 || raw.indexOf("landed") !== -1;
}
function readDepartedStore(){
  var today = todayIso();
  try {
    var raw = localStorage.getItem(DEPARTED_STORE_KEY);
    var parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.date === today && parsed.flights && typeof parsed.flights === "object") return parsed;
  } catch (_) {}
  return { date: today, flights: {} };
}
function writeDepartedStore(store){
  try { localStorage.setItem(DEPARTED_STORE_KEY, JSON.stringify(store)); } catch (_) {}
}
function rememberConfirmedAirborne(f, fs){
  if (!f || !isConfirmedAirborneOrBeyond(fs)) return;
  var store = readDepartedStore();
  store.flights[flightIdentity(f)] = fs;
  writeDepartedStore(store);
}
function restoredConfirmedAirborne(f){
  var store = readDepartedStore();
  return store.flights[flightIdentity(f)] || null;
}
function alreadyConfirmedAirborne(f){
  return isConfirmedAirborneOrBeyond(statuses[f.flight]);
}

function sessionSnapshot(){
  return {
    date: todayIso(),
    ficoText: byId("ficoInput").value || "",
    hsbStart: byId("hsbStart").value || "12:00",
    hsbEnd: byId("hsbEnd").value || "20:00",
    flights: flights,
    statuses: statuses,
    lastLiveRefreshAt: lastLiveRefreshAt,
    clientSavedAt: new Date().toISOString()
  };
}
function queueSaveSession(){
  if (!sessionReady) return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(function(){
    sessionSaveTimer = null;
    saveSessionToServer();
  }, SESSION_SAVE_DELAY_MS);
}
function saveSessionToServer(){
  if (!sessionReady) return Promise.resolve();
  var payload = { session: sessionSnapshot() };
  sessionSaveSerial = sessionSaveSerial.catch(function(){}).then(async function(){
    try {
      var res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store"
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || "session save failed");
    } catch (e) {
      console.warn("Session save failed", e);
    }
  });
  return sessionSaveSerial;
}
function saveSessionOnPageHide(){
  if (!sessionReady) return;
  try {
    var body = JSON.stringify({ session: sessionSnapshot() });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/session", new Blob([body], { type: "application/json" }));
      return;
    }
    fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true, cache: "no-store" }).catch(function(){});
  } catch (_) {}
}

async function loadSessionFromServer(){
  var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = controller ? setTimeout(function(){ controller.abort(); }, 2500) : null;
  try {
    var opts = { cache: "no-store" };
    if (controller) opts.signal = controller.signal;
    var res = await fetch("/api/session", opts);
    var data = await res.json();
    if (data && data.ok && data.session && data.date === todayIso()) return data.session;
  } catch (e) {
    console.warn("Session load failed; using local/default state", e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return null;
}
function restoreStatusesFromSession(snapshot){
  if (!snapshot || !snapshot.statuses || !snapshot.flights) return;
  var savedFlights = {};
  snapshot.flights.forEach(function(f){ if (f && f.flight) savedFlights[f.flight] = f; });
  flights.forEach(function(f){
    var old = savedFlights[f.flight];
    if (old && flightIdentity(old) === flightIdentity(f) && snapshot.statuses[f.flight]) {
      statuses[f.flight] = snapshot.statuses[f.flight];
      rememberConfirmedAirborne(f, statuses[f.flight]);
    }
  });
  var savedRefresh = Number(snapshot.lastLiveRefreshAt);
  lastLiveRefreshAt = Number.isFinite(savedRefresh) && savedRefresh > 0 ? savedRefresh : null;
}

function parseFico(text){
  var parsed = [];
  var targetServiceDate = null;
  var lines = String(text || "").split(String.fromCharCode(10));
  for (var i=0; i<lines.length; i++){
    var line = lines[i].trim();
    if (!line) continue;
    var parts = line.split(" ").filter(function(x){ return x.length > 0; });
    if (parts.length < 5) continue;
    var flightToken=parts[0];
    var flightBase=flightToken.split("/")[0];
    if (digitsOnly(flightBase).length !== 3 || digitsOnly(flightBase)!==flightBase) continue;
    var serviceDate=serviceDateFromFlightToken(flightToken);
    if(!serviceDate)continue;
    if(targetServiceDate===null)targetServiceDate=serviceDate;
    if(serviceDate!==targetServiceDate)continue; // one HSB/service day per table
    if (parts[1].indexOf("-") === -1) continue;
    var routeParts = parts[1].split("-");
    if (routeParts.length !== 2) continue;
    if (routeParts[0] !== "LHR") continue;
    var flight = "BA" + flightBase.padStart(3, "0");
    var schedTO = compactToMin(parts[2]);
    var isFicoCancelled = parts.indexOf("X") !== -1;
    var arrToken = null;
    for (var j=3; j<parts.length; j++){
      // PTA is a plain four-digit time. Revised ETDs such as R1430 are
      // deliberately ignored here so they cannot be mistaken for arrival.
      if (parts[j].length === 4 && digitsOnly(parts[j]) === parts[j]) { arrToken = parts[j]; break; }
    }
    if (!arrToken) arrToken = "0000";
    var schedArr = compactToMin(arrToken);
    if (schedArr <= schedTO) schedArr += 1440;
    parsed.push({ flight:flight, serviceDate:serviceDate, from:routeParts[0], to:routeParts[1], route:parts[1], schedTO:schedTO, schedArr:schedArr, block:schedArr-schedTO, ficoCancelled:isFicoCancelled });
  }
  return parsed.sort(function(a,b){ return a.schedTO - b.schedTO; });
}

async function checkUsage(){
  try {
    var res = await fetch("/api/usage", { cache: "no-store" });
    var data = await res.json();
    usageGuard = data;
    if (!data.ok) {
      var blockedLine = "AeroAPI blocked: " + (data.error || "usage guard unavailable");
      byId("usageGuard").innerHTML = "<strong class='bad'>" + blockedLine + "</strong>";
      byId("headerUsage").textContent = blockedLine;
      return;
    }
    var callClass = "calls-green";
    if (data.calls >= 1000 || data.remaining_usd <= 1) callClass = "calls-red";
    else if (data.calls >= 100 || data.remaining_usd <= 3) callClass = "calls-amber";
    var usageLineText = "AeroAPI guard active. Used this month: " + money(data.used_usd) + " / $" + Number(data.cap_usd).toFixed(2) + ". Remaining: " + money(data.remaining_usd) + ". Calls: " + data.calls + ". Cache: " + Math.round(data.cache_ttl_seconds/60) + " min.";
    var usageLineHtml = "AeroAPI guard active. Used this month: " + money(data.used_usd) + " / $" + Number(data.cap_usd).toFixed(2) + ". Remaining: " + money(data.remaining_usd) + ". Calls: <span class='" + callClass + "'>" + data.calls + "</span>. Cache: " + Math.round(data.cache_ttl_seconds/60) + " min.";
    byId("usageGuard").innerHTML = "<strong class='ok'>" + usageLineHtml + "</strong>";
    byId("headerUsage").innerHTML = usageLineHtml;
  } catch(e) {
    usageGuard = null;
    byId("usageGuard").innerHTML = "<strong class='bad'>AeroAPI blocked: usage check failed.</strong>";
    byId("headerUsage").textContent = "AeroAPI blocked: usage check failed.";
    showError("Usage check failed: " + String(e));
  }
}

function setRefreshBusy(busy,label){
  var btn=byId("statusBtn");
  if(!btn)return;
  btn.disabled=!!busy;
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  var parseBtn=byId("parseBtn");
  if(parseBtn)parseBtn.disabled=!!busy;
  if(busy){
    btn.innerHTML = "<span class='refresh-spinner' aria-hidden='true'></span>" + (label || "Refreshing...");
  }else{
    btn.textContent="Refresh live status";
  }
}

async function refreshStatus(){
  setRefreshBusy(true,"Checking...");
  byId("parseNote").textContent="Checking AeroAPI allowance...";
  try {
  if (!flights.length) parseAndRender();
  await checkUsage();
  if (!usageGuard || !usageGuard.ok) {
    byId("parseNote").textContent = "Live refresh blocked: usage guard unavailable.";
    return;
  }
  var hsbStartForRefresh = toMin(byId("hsbStart").value);
  var hsbEndForRefresh = normaliseEnd(hsbStartForRefresh, toMin(byId("hsbEnd").value));
  var refreshableCount = flights.filter(function(f){ return !f.ficoCancelled && !cannotCoverFromHsb(f, hsbStartForRefresh) && !alreadyConfirmedAirborne(f) && !callabilityFromHsb(f,hsbStartForRefresh,hsbEndForRefresh).tooLate; }).length;
  var estimated = refreshableCount * COST_PER_FLIGHT_USD;
  var ok = confirm("Refresh live status for " + refreshableCount + " flights? Estimated maximum cost " + money(estimated) + ". FICO-cancelled, cannot-cover, too-late-from-HSB and confirmed taken-off flights are not queried. Cached results may cost less. Monthly app cap is $" + Number(usageGuard.cap_usd).toFixed(2) + ".");
  if (!ok) {
    byId("parseNote").textContent = "Live refresh cancelled. No AeroAPI calls made.";
    return;
  }
  setRefreshBusy(true,"Refreshing...");
  byId("parseNote").textContent = "Refreshing live status...";
  try {
    var hsbStartForRefresh = toMin(byId("hsbStart").value);
    var hsbEndForRefresh = normaliseEnd(hsbStartForRefresh, toMin(byId("hsbEnd").value));
    var refreshable = flights.filter(function(f){ return !f.ficoCancelled && !cannotCoverFromHsb(f, hsbStartForRefresh) && !alreadyConfirmedAirborne(f) && !callabilityFromHsb(f,hsbStartForRefresh,hsbEndForRefresh).tooLate; });
    if (!refreshable.length) {
      byId("parseNote").textContent = "No AeroAPI calls made. All parsed flights are cancelled, cannot be covered from this HSB, are already too late to use from this HSB, or are already confirmed taken off.";
      return;
    }
    var meta = {};
    refreshable.forEach(function(f){ meta[f.flight] = { from: f.from, to: f.to, schedTO: f.schedTO, serviceDate: f.serviceDate || activeServiceDate() }; });
    var query = refreshable.map(function(f){ return f.flight; }).join(",");
    var res = await fetch("/api/status?flights=" + encodeURIComponent(query) + "&meta=" + encodeURIComponent(JSON.stringify(meta)), { cache: "no-store" });
    var data = await res.json();
    if (!data.ok) {
      byId("parseNote").textContent = "Live refresh blocked/error: " + (data.error || "unknown");
      if (data.error) showError(data.error);
      return;
    }
    var returnedStatuses = data.flights || {};
    var mergedStatuses = {};
    flights.forEach(function(f){
      if (statuses[f.flight]) mergedStatuses[f.flight] = statuses[f.flight];
      if (returnedStatuses[f.flight]) mergedStatuses[f.flight] = returnedStatuses[f.flight];
    });
    statuses = mergedStatuses;
    flights.forEach(function(f){ rememberConfirmedAirborne(f, statuses[f.flight]); });
    lastLiveRefreshAt = Date.parse(data.updated) || Date.now();
    byId("parseNote").textContent = "Updated " + liveAgeText() + ". Paid calls: " + data.paid_calls_this_refresh + ". Cost: " + money(data.estimated_cost_this_refresh_usd) + ". Used this month: " + money(data.used_usd) + ".";
    await checkUsage();
    updateLiveLine();
    render();
    queueSaveSession();
  } catch(e) {
    byId("parseNote").textContent = "Live status fetch failed: " + String(e);
    showError("Live status fetch failed: " + String(e));
  }
  } finally {
    setRefreshBusy(false);
  }
}

function flightIdentity(f){
  return [f.flight, f.serviceDate || todayIso(), f.route, f.schedTO, f.schedArr, f.ficoCancelled ? "X" : ""].join("|");
}
function compactFicoText(text){
  return String(text || "").split(/\\r?\\n/).filter(function(line){ return line.trim().length > 0; }).join("\\n");
}
function parseAndRender(){
  var text = compactFicoText(byId("ficoInput").value);
  byId("ficoInput").value = text;
  localStorage.setItem(STORAGE_KEY, text);
  var oldByFlight = {};
  flights.forEach(function(f){ oldByFlight[f.flight] = f; });
  var oldStatuses = statuses;
  var nextFlights = parseFico(text);
  var nextStatuses = {};
  nextFlights.forEach(function(f){
    var old = oldByFlight[f.flight];
    if (old && flightIdentity(old) === flightIdentity(f) && oldStatuses[f.flight]) {
      nextStatuses[f.flight] = oldStatuses[f.flight];
    } else {
      var restored = restoredConfirmedAirborne(f);
      if (restored) nextStatuses[f.flight] = restored;
    }
  });
  flights = nextFlights;
  statuses = nextStatuses;
  var hsbStartForSummary = toMin(byId("hsbStart").value);
  var hsbEndForSummary = normaliseEnd(hsbStartForSummary, toMin(byId("hsbEnd").value));
  var cancelledCount = flights.filter(function(f){ return f.ficoCancelled; }).length;
  var cannotCoverCount = flights.filter(function(f){ return !f.ficoCancelled && cannotCoverFromHsb(f, hsbStartForSummary); }).length;
  var airborneCount = flights.filter(function(f){ return !f.ficoCancelled && !cannotCoverFromHsb(f, hsbStartForSummary) && alreadyConfirmedAirborne(f); }).length;
  var tooLateCount = flights.filter(function(f){ return !f.ficoCancelled && !cannotCoverFromHsb(f, hsbStartForSummary) && !alreadyConfirmedAirborne(f) && callabilityFromHsb(f,hsbStartForSummary,hsbEndForSummary).tooLate; }).length;
  var refreshableCount = flights.length - cancelledCount - cannotCoverCount - airborneCount - tooLateCount;
  var serviceLabel = flights.length && flights[0].serviceDate ? (" Service date: " + flights[0].serviceDate + ".") : "";
  byId("parseNote").textContent = "Parsed " + flights.length + " flights." + serviceLabel + " " + cancelledCount + " FICO-cancelled. " + cannotCoverCount + " cannot cover. " + tooLateCount + " too late from this HSB. " + airborneCount + " already taken off. Estimated max refresh cost: " + money(refreshableCount * COST_PER_FLIGHT_USD) + ".";
  render();
  queueSaveSession();
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
  var hsbNotStarted = hsbStartDelta > 0;
  var hsbFinished = hsbFinishDelta < 0;
  var rows = flights.map(function(f){
    var latestTO = latestOnBlocks - f.block;
    var capability=callabilityFromHsb(f,hsbStart,hsbEnd);
    var latestCall = capability.latestUsefulCall;
    var callBy = capability.callBy;
    var callByReason = capability.tooLate ? (capability.callLimiter+" makes latest useful call before HSB starts") : ("Limited by "+capability.callLimiter);
    var delta = capability.tooLate ? -1 : futureDelta(callBy, now);
    var fs = f.ficoCancelled ? { status:"cancelled", found:true, label:"Cancelled", safe_by_status:true, source:"fico" } : (statuses[f.flight] || { status:"no_live_refresh", found:false, label:null, safe_by_status:false });
    var cannotCover = cannotCoverFromHsb(f, hsbStart);
    var row = Object.assign({}, f, { latestOnBlocks:latestOnBlocks, latestTO:latestTO, latestCall:latestCall, callBy:callBy, callByReason:callByReason, delta:delta, fs:fs, cannotCoverFromThisHsb:cannotCover, tooLateFromThisHsb:capability.tooLate, hsbStartForDetail:hsbStart, callLimiter:capability.callLimiter });
    row.crewInfo = capability.crewInfo;
    row.augmentationInfo = capability.augmentationInfo;
    return row;
  });
  return { rows:rows, hsbStart:hsbStart, hsbEnd:hsbEnd, latestOnBlocks:latestOnBlocks, now:now, hsbStartDelta:hsbStartDelta, hsbFinishDelta:hsbFinishDelta, hsbNotStarted:hsbNotStarted, hsbFinished:hsbFinished };
}

function apiHasUsefulStatus(f){ return f.fs && f.fs.found && f.fs.label && f.fs.label !== "Unknown"; }
function scheduledEtdPassed(f,state){
  if (!f || !state) return false;
  var sched = f.schedTO;
  while (sched < state.now - 720) sched += 1440;
  return state.now >= sched;
}
function operationalStatus(f,state){
  if (f.fs && f.fs.safe_by_status) return f.fs.label || "Departed";
  if (f.cannotCoverFromThisHsb) return ">19h from HSB";
  if (f.tooLateFromThisHsb) return "Too late";
  if (state.hsbFinished || f.delta < 0) return "Safe";
  if (apiHasUsefulStatus(f)) return f.fs.label;
  if (f.fs && f.fs.status === "no_live_refresh" && scheduledEtdPassed(f,state)) return "Past ETD — refresh";
  if (state.now >= f.schedTO) return "Unknown";
  return "Planned";
}
function isSafe(f,state){ return (f.fs && f.fs.safe_by_status) || f.cannotCoverFromThisHsb || f.tooLateFromThisHsb || state.hsbFinished || f.delta < 0; }
function dotClassFor(f,state){
  if (f.cannotCoverFromThisHsb || f.tooLateFromThisHsb || (f.fs && f.fs.safe_by_status)) return "dot-green";
  if(state.hsbNotStarted)return"dot-blue";
  if(isSafe(f,state))return"dot-green";
  if(f.delta<=30)return"dot-red";
  if (f.fs && f.fs.status === "no_live_refresh") return "dot-grey";
  if(operationalStatus(f,state)==="Unknown" || operationalStatus(f,state)==="Past ETD — refresh")return"dot-grey";
  return"dot-amber";
}
function rowClassFor(f,state){
  if (f.cannotCoverFromThisHsb || f.tooLateFromThisHsb || (f.fs && f.fs.safe_by_status)) return "row-departed";
  if(state.hsbNotStarted)return"row-pre";
  if(isSafe(f,state))return f.fs && f.fs.safe_by_status ? "row-departed" : "row-safe";
  if(f.delta<=30)return"row-critical";
  if (f.fs && f.fs.status === "no_live_refresh") return "";
  return"row-live";
}
function statusClass(f,state){ var s=operationalStatus(f,state); if(s==="Planned")return"status-planned"; if(s==="Past ETD — refresh")return"status-unknown"; if(s==="Delayed")return"status-delayed"; if(s==="Safe"||s==="Departed"||s==="Cancelled"||s==="Diverted"||s===">19h from HSB"||s==="Too late")return"status-safe"; if(s==="Unknown")return"status-unknown"; return"status-live"; }
function countdownText(f,state){
  if(isSafe(f,state))return"Safe";
  if(f.delta < 0)return"Expired";
  return dur(f.delta);
}
function liveDepartureDetails(f){
  if (!f.fs || !f.fs.found) return "";
  var scheduled = Date.parse(f.fs.scheduled_out || f.fs.scheduled_off || "");
  var estimatedIso = f.fs.estimated_out || f.fs.estimated_off || "";
  var estimated = Date.parse(estimatedIso);
  if (!scheduled || !estimated || estimated <= scheduled) return "";
  var delayMins = Math.max(1, Math.round((estimated - scheduled) / 60000));
  var d = new Date(estimated);
  var newEtd = String(d.getUTCHours()).padStart(2,"0") + String(d.getUTCMinutes()).padStart(2,"0") + "Z";
  return "Delayed " + delayMins + "m · New ETD " + newEtd;
}
function statusHtml(f,state){
  var op = operationalStatus(f,state);
  var ci=f.crewInfo;
  var etd=estimatedDepartureMins(f);
  var crossed=ci && etd!==null && etd>=ci.originalOperationalLatest;
  var crossedLabel=ci && ci.originalLimiter.indexOf("BLR")===0 ? "BLR crew limit" : "Crew FDP";
  if (op !== "Delayed") return crossed ? op + " · " + crossedLabel : op;
  var details = liveDepartureDetails(f) || op;
  return crossed ? details + " · " + crossedLabel : details;
}

function todayIso(){ return new Date().toISOString().slice(0,10); }
function flightNumberOnly(flight){ return digitsOnly(String(flight || "").startsWith("BA") ? String(flight).slice(2) : flight); }
function baStatusUrl(flight,date){ return "https://www.britishairways.com/travel/flightstatus/public/en_us/results/loaded?searchMethod=flight&date=" + (date||todayIso()) + "&isDepartures=true&flightNumber=" + encodeURIComponent(flightNumberOnly(flight)); }
function lhrStatusUrl(flight){ return "https://www.heathrow.com/departures/terminal-5/flight-details/" + encodeURIComponent(flight); }
function flightAwarePublicUrl(flight){ var raw = flightNumberOnly(flight); var num = raw.replace(/^0+/, "") || raw; return "https://uk.flightaware.com/live/flight/BAW" + encodeURIComponent(num); }
function checksHtml(f){ var flight=f.flight||f; var date=f.serviceDate||todayIso(); return "<div class='checks'><a class='check-link ba' target='_blank' rel='noopener' href='" + baStatusUrl(flight,date) + "'>BA</a><a class='check-link lhr' target='_blank' rel='noopener' href='" + lhrStatusUrl(flight) + "'>LHR</a><a class='check-link fa' target='_blank' rel='noopener' href='" + flightAwarePublicUrl(flight) + "'>FA</a></div>"; }

function render(){
  byId("utcClock").textContent = utcNowText();
  updateLiveLine();
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
      "<td class='route'>" + f.route + "</td>" +
      "<td class='center'><strong>" + twoHoursBeforeReportLocal(f) + "</strong></td>" +
      "<td>" + fmtShort(scheduledReportMins(f)) + "</td>" +
      "<td>" + fmtShort(f.schedTO) + "</td>" +
      "<td>" + minToBlock(f.block) + "</td>" +
      "<td><button class='call-by-btn badge " + callBadge + "' data-detail-index='" + i + "' title='" + f.callByReason + "'>" + (f.tooLateFromThisHsb ? "Too late" : fmt(f.callBy)) + "</button></td>" +
      "<td class='" + statusClass(f,state) + "'>" + statusHtml(f,state) + "</td>" +
      "<td>" + countdownText(f,state) + "</td>" +
      "<td>" + checksHtml(f) + "</td>";
    rowsEl.appendChild(tr);
  }
  function insertCrewDetail(btn,row,idx){
    var flightRow=btn.closest("tr");
    var detailRow=document.createElement("tr");
    detailRow.className="crew-detail-row";
    detailRow.setAttribute("data-crew-index",String(idx));
    var detailCell=document.createElement("td");
    detailCell.colSpan=11;
    var detail=document.createElement("div");
    detail.className="crew-detail";
    var close=document.createElement("button");
    close.type="button"; close.className="crew-detail-close"; close.textContent="Close";
    var data=crewDetailData(row,row.crewInfo);
    var limiting=document.createElement("div");
    limiting.className="limiting-rule";
    limiting.textContent=data.limiting;
    var detailText=document.createElement("div");
    detailText.className="crew-detail-text";
    detailText.textContent=data.text;
    close.addEventListener("click",function(){ selectedCrewFlight=null; render(); });
    detail.appendChild(close); detail.appendChild(limiting); detail.appendChild(detailText); detailCell.appendChild(detail); detailRow.appendChild(detailCell);
    flightRow.insertAdjacentElement("afterend",detailRow);
  }
  rowsEl.querySelectorAll(".call-by-btn").forEach(function(btn){
    btn.addEventListener("click",function(){
      var idx=Number(btn.getAttribute("data-detail-index")); var row=state.rows[idx];
      if(!row || !row.crewInfo) return;
      selectedCrewFlight=(selectedCrewFlight===row.flight ? null : row.flight);
      render();
    });
  });
  if(selectedCrewFlight){
    var selectedIdx=state.rows.findIndex(function(r){ return r.flight===selectedCrewFlight; });
    if(selectedIdx>=0 && state.rows[selectedIdx].crewInfo){
      var selectedBtn=rowsEl.querySelector(".call-by-btn[data-detail-index='"+selectedIdx+"']");
      if(selectedBtn) insertCrewDetail(selectedBtn,state.rows[selectedIdx],selectedIdx);
    } else selectedCrewFlight=null;
  }
}

async function start(){
  // Paint a usable app immediately. Remote session restore must never block startup.
  byId("utcClock").textContent = utcNowText();
  parseAndRender();
  byId("parseBtn").addEventListener("click", parseAndRender);
  byId("selectFicoBtn").addEventListener("click", function(){
    var box = byId("ficoInput");
    try { box.focus({ preventScroll:true }); } catch (_) { box.focus(); }
    box.select();
    try { box.setSelectionRange(0, box.value.length); } catch (_) {}
    var btn = byId("selectFicoBtn");
    btn.classList.add("selected");
    setTimeout(function(){ btn.classList.remove("selected"); }, 900);
  });
  byId("statusBtn").addEventListener("click", refreshStatus);
  byId("usageBtn").addEventListener("click", checkUsage);
  byId("hsbStart").addEventListener("input", function(){
    localStorage.setItem(HSB_START_KEY, byId("hsbStart").value);
    render();
    queueSaveSession();
  });
  byId("hsbEnd").addEventListener("input", function(){
    localStorage.setItem(HSB_END_KEY, byId("hsbEnd").value);
    render();
    queueSaveSession();
  });
  byId("ficoInput").addEventListener("input", function(){
    try { localStorage.setItem(STORAGE_KEY, byId("ficoInput").value); } catch (_) {}
    queueSaveSession();
  });
  window.addEventListener("pagehide", saveSessionOnPageHide);

  var remote = await loadSessionFromServer();
  if (remote) {
    if (remote.hsbStart) byId("hsbStart").value = remote.hsbStart;
    if (remote.hsbEnd) byId("hsbEnd").value = remote.hsbEnd;
    if (typeof remote.ficoText === "string" && remote.ficoText.length) byId("ficoInput").value = remote.ficoText;
    try {
      localStorage.setItem(HSB_START_KEY, byId("hsbStart").value);
      localStorage.setItem(HSB_END_KEY, byId("hsbEnd").value);
      localStorage.setItem(STORAGE_KEY, byId("ficoInput").value);
    } catch (_) {}
    parseAndRender();
    restoreStatusesFromSession(remote);
    render();
  } else {
    var savedStart = localStorage.getItem(HSB_START_KEY);
    var savedEnd = localStorage.getItem(HSB_END_KEY);
    if (savedStart) byId("hsbStart").value = savedStart;
    if (savedEnd) byId("hsbEnd").value = savedEnd;
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) byId("ficoInput").value = saved;
    parseAndRender();
  }

  sessionReady = true;
  queueSaveSession();
  checkUsage();
  setInterval(render, 10000);
}

start().catch(function(e){ showError("Frontend startup error: " + String(e)); byId("utcClock").textContent = "ERROR"; });
})();
</script>
</body>
</html>`;
}
