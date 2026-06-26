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
    if (url.pathname === "/api/status") return handleStatus(request, env);
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
  for (const flight of requestedFlights) results[flight] = emptyFlight(flight);

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
        airport: dep.airport || null,
        iata: dep.iata || null,
        timezone: dep.timezone || null,
        terminal: dep.terminal || null,
        gate: dep.gate || null,
        delay: dep.delay ?? null,
        scheduled: dep.scheduled || null,
        estimated: dep.estimated || null,
        actual: dep.actual || null,
        estimated_runway: dep.estimated_runway || null,
        actual_runway: dep.actual_runway || null
      },
      arrival: {
        airport: arr.airport || null,
        iata: arr.iata || null,
        timezone: arr.timezone || null,
        terminal: arr.terminal || null,
        gate: arr.gate || null,
        baggage: arr.baggage || null,
        delay: arr.delay ?? null,
        scheduled: arr.scheduled || null,
        estimated: arr.estimated || null,
        actual: arr.actual || null,
        estimated_runway: arr.estimated_runway || null,
        actual_runway: arr.actual_runway || null
      },
      aircraft: best.aircraft || null,
      live: best.live || null
    };
  }

  const response = jsonResponse({
    ok: true,
    version: "v3",
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

  // AviationStack may store BA055 as BA55 and BA057 as BA57.
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
  const todayMatches = matches.filter(item => item.flight_date === today);
  const candidates = todayMatches.length ? todayMatches : matches;

  const statusRank = { active: 1, landed: 2, scheduled: 3, cancelled: 4, diverted: 5, incident: 6 };

  return candidates.sort((a, b) => {
    const ra = statusRank[a.flight_status] || 99;
    const rb = statusRank[b.flight_status] || 99;
    if (ra !== rb) return ra - rb;
    const ta = Date.parse(a?.departure?.scheduled || "") || 0;
    const tb = Date.parse(b?.departure?.scheduled || "") || 0;
    return tb - ta;
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
    return { status: "incident", label: "Incident", confidence: "uncertain", safe_by_status: false };
  }

  if (rawStatus === "landed" || arr?.actual || arr?.actual_runway) {
    return { status: "landed", label: "Landed", confidence: "confirmed", safe_by_status: true };
  }

  const hasDepartureEvidence = Boolean(dep?.actual || dep?.actual_runway || live);
  if (hasDepartureEvidence) {
    return { status: "departed", label: live ? "Airborne" : "Departed", confidence: "confirmed", safe_by_status: true };
  }

  if (rawStatus === "active") {
    return { status: "awaiting_departure_confirmation", label: "Awaiting departure confirmation", confidence: "uncertain", safe_by_status: false };
  }

  if (rawStatus === "scheduled") {
    if (dep?.estimated && dep?.scheduled && dep.estimated !== dep.scheduled) {
      return { status: "not_departed", label: "Delayed / estimated", confidence: "scheduled", safe_by_status: false };
    }
    return { status: "not_departed", label: "Scheduled", confidence: "scheduled", safe_by_status: false };
  }

  return { status: rawStatus || "unknown", label: rawStatus || "Unknown", confidence: "unknown", safe_by_status: false };
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
:root{--bg:#f3f4f6;--card:#fff;--ink:#111;--muted:#555;--line:#e1e4e8;--soft:#f0f3f7;--ok:#0a6b28;--amber:#8a5a00;--call-bg:#fff4ce;--safe-bg:#f1f1f1;--live-bg:#eef8f0;--crit-bg:#fff6dc;--pre-bg:#eef3ff;--dep-bg:#e8f0ff;--bad:#a40000}
*{box-sizing:border-box}
body{margin:0;padding:10px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.app{max-width:1320px;margin:0 auto;padding:12px 0 18px}
.card{background:var(--card);border-radius:18px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden}
.top,.fico{padding:16px;margin-bottom:12px}
h1{margin:0 0 6px;font-size:1.35rem}.sub{margin:0;color:var(--muted);font-size:.94rem;line-height:1.35}
.grid{display:grid;grid-template-columns:minmax(150px,220px) minmax(150px,220px) 1fr;gap:12px;align-items:end;margin-top:14px}
label{display:block;font-size:.8rem;font-weight:800;color:#333;margin:0 0 5px}
input,textarea{width:100%;border:1px solid #ccd1d8;border-radius:12px;padding:12px 10px;font-size:1.05rem;background:#fff;color:var(--ink)}
input{text-align:center}
textarea{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86rem;line-height:1.35;resize:vertical}
.clock{background:#111;color:#fff;border-radius:12px;padding:12px;font-weight:900;text-align:center;font-size:1.1rem}
.summary{margin-top:12px;padding:12px;background:var(--soft);border-radius:12px;font-size:.9rem;line-height:1.4}
.alive{margin-top:12px;padding:12px;background:#f8f9fb;border:1px solid var(--line);border-radius:12px;font-size:.9rem;line-height:1.45}
.alive-title{font-weight:900;margin-bottom:7px}
.tile{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:8px;align-items:center;margin:6px 0;padding:9px 10px;border-radius:12px;border:1px solid var(--line)}
.tile.live{background:var(--live-bg)}.tile.critical{background:var(--crit-bg)}.tile.pre{background:var(--pre-bg)}
.tile .call{font-weight:900}.tile .remaining{font-weight:900;text-align:right}
.button-row{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}
button{border:0;border-radius:12px;padding:11px 14px;background:#111;color:#fff;font-weight:900;font-size:.95rem}
button.secondary{background:#555}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;min-width:1460px;border-collapse:collapse;font-size:.88rem}
th,td{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;white-space:nowrap;vertical-align:top}
th{background:#f8f9fb;font-weight:900;font-size:.78rem;color:#333}
.badge{background:var(--call-bg);font-weight:900;border-radius:8px;display:inline-block;padding:4px 7px}
.ok{color:var(--ok);font-weight:900}.amber{color:var(--amber);font-weight:900}.safe{color:#000;font-weight:900}.prestatus{color:#244e9b;font-weight:900}.bad{color:var(--bad);font-weight:900}.uncertain{color:#8a5a00;font-weight:900}
.row-safe{background:var(--safe-bg);color:#000}.row-safe td{color:#000}.row-safe .badge{background:#fff;color:#000}.row-pre{background:#fbfdff}.row-departed{background:var(--dep-bg)}.row-uncertain{background:#fffaf0}
.status-link{display:inline-block;text-decoration:none;background:#111;color:#fff;padding:7px 9px;border-radius:9px;font-size:.78rem;font-weight:900}
.note{color:var(--muted);font-size:.78rem;line-height:1.35;padding:12px 14px;border-top:1px solid var(--line);background:#fbfbfc}
.parse-note{margin-top:8px;color:var(--muted);font-size:.82rem;line-height:1.35}
@media(max-width:700px){.grid{grid-template-columns:1fr}.tile{grid-template-columns:1fr}.tile .remaining{text-align:left}table{font-size:.82rem;min-width:1380px}th,td{padding:8px 6px}.button-row{display:block}button{width:100%;margin-top:8px}}
</style>
</head>
<body>
<main class="app">
<section class="card top">
<h1>HSB Reserve App v3</h1>
<p class="sub">Paste BA/FICO aircraft list, enter HSB start/finish, and the app calculates safe-after times. Flight status refreshes automatically.</p>
<div class="grid">
<div><label for="hsbStart">HSB start Z</label><input id="hsbStart" type="time" value="12:00"></div>
<div><label for="hsbEnd">HSB finish Z</label><input id="hsbEnd" type="time" value="20:00"></div>
<div class="clock" id="utcClock">UTC ----Z</div>
</div>
<div id="summary" class="summary"></div><div id="aliveList" class="alive"></div>
</section>
<section class="card fico">
<label for="ficoInput">Paste BA/FICO flight list</label>
<textarea id="ficoInput" spellcheck="false">${escapedFico}</textarea>
<div class="button-row"><button id="parseBtn">Parse FICO list</button><button id="statusBtn" class="secondary">Refresh flight status</button></div>
<div id="parseNote" class="parse-note">Tomorrow rows such as 207/27 are ignored.</div>
</section>
<section class="card">
<div class="table-scroll">
<table>
<thead><tr><th>Flight</th><th>Reg</th><th>Route</th><th>Sched T/O</th><th>Sched arr</th><th>Block</th><th>Latest on-blocks</th><th>Latest T/O</th><th>Latest call</th><th>Safe after</th><th>Flight status</th><th>Confidence</th><th>Delay</th><th>Countdown</th><th>Reserve status</th><th>Google</th></tr></thead>
<tbody id="rows"></tbody>
</table>
</div>
<div class="note">v3: active alone is not treated as airborne. Departure requires actual departure/runway/live data. BA055/BA057 are also queried as BA55/BA57.</div>
</section>
</main>
<script>
let flights=[];let statuses={};let lastStatusUpdate=null;
const HSB_TO_CHOCKS_LIMIT=1140,CALL_BEFORE_TAKEOFF=120;
const STORAGE_KEY="hsb-reserve-fico-v3";
function toMin(t){const p=t.split(":").map(Number);return p[0]*60+p[1]}
function compactToMin(s){s=String(s).replace(/\\D/g,"").padStart(4,"0");return Number(s.slice(0,2))*60+Number(s.slice(2,4))}
function minToBlock(mins){mins=Math.abs(mins);return String(Math.floor(mins/60)).padStart(2,"0")+":"+String(mins%60).padStart(2,"0")}
function fmt(mins){const plus=mins>=1440?" +1":"";mins=((mins%1440)+1440)%1440;return String(Math.floor(mins/60)).padStart(2,"0")+String(mins%60).padStart(2,"0")+"Z"+plus}
function dur(mins){mins=Math.abs(mins);return Math.floor(mins/60)+"h"+String(mins%60).padStart(2,"0")}
function utcNowMinutes(){const d=new Date();return d.getUTCHours()*60+d.getUTCMinutes()}
function utcNowText(){const d=new Date();return String(d.getUTCHours()).padStart(2,"0")+String(d.getUTCMinutes()).padStart(2,"0")+"Z"}
function futureDelta(targetMins,nowMins){let target=targetMins;while(target<nowMins-720)target+=1440;return target-nowMins}
function normaliseEnd(start,end){return end<=start?end+1440:end}
function parseFico(text){const parsed=[];for(const rawLine of text.split(/\\n/)){const line=rawLine.trim();if(line.match(/^\\d{3}\\/\\d{1,2}/))continue;const m=line.match(/^(\\d{3})\\s+([A-Z]{3})-([A-Z]{3})\\s+(\\d{4})\\S*\\s+\\S+\\s+\\S+\\s+(\\d{4})/);if(!m)continue;const[,num,from,to,ptd,pta]=m;const schedTO=compactToMin(ptd);let schedArr=compactToMin(pta);if(schedArr<=schedTO)schedArr+=1440;parsed.push({flight:"BA"+num,from,to,route:from+"-"+to,schedTO,schedArr,block:schedArr-schedTO})}return parsed.sort((a,b)=>a.schedTO-b.schedTO)}
async function refreshStatus(){if(!flights.length)return;const query=flights.map(f=>f.flight).join(",");try{const res=await fetch("/api/status?flights="+encodeURIComponent(query));const data=await res.json();if(data.ok&&data.flights){statuses=data.flights;lastStatusUpdate=new Date(data.updated);document.getElementById("parseNote").textContent="Flight status updated: "+lastStatusUpdate.toUTCString()}else{document.getElementById("parseNote").textContent="Flight status error: "+(data.error||"unknown")}}catch(e){document.getElementById("parseNote").textContent="Flight status fetch failed: "+e}render()}
function parseAndRender(){const text=document.getElementById("ficoInput").value;localStorage.setItem(STORAGE_KEY,text);flights=parseFico(text);statuses={};document.getElementById("parseNote").textContent="Parsed "+flights.length+" flights. Tomorrow rows ignored.";render();refreshStatus()}
function render(){document.getElementById("utcClock").textContent="UTC "+utcNowText();const startInput=document.getElementById("hsbStart").value,endInput=document.getElementById("hsbEnd").value;if(!startInput||!endInput)return;const hsbStart=toMin(startInput),hsbEnd=normaliseEnd(hsbStart,toMin(endInput)),latestOnBlocks=hsbStart+HSB_TO_CHOCKS_LIMIT,now=utcNowMinutes();const hsbStartDelta=futureDelta(hsbStart,now),hsbFinishDelta=futureDelta(hsbEnd,now);const hsbNotStarted=hsbStartDelta>0&&hsbStartDelta<720,hsbFinished=hsbFinishDelta<0;const statusAge=lastStatusUpdate?Math.max(0,Math.round((Date.now()-lastStatusUpdate.getTime())/1000))+"s ago":"not yet updated";document.getElementById("summary").innerHTML="<strong>HSB:</strong> "+fmt(hsbStart)+"–"+fmt(hsbEnd)+"<br><strong>Latest on-blocks:</strong> "+fmt(latestOnBlocks)+"<br><strong>Flights parsed:</strong> "+flights.length+"<br><strong>Status updated:</strong> "+statusAge+"<br><strong>Rule:</strong> Safe after the earlier of latest call, HSB finish, confirmed departure/landing, cancellation or diversion.";const computed=flights.map(f=>{const latestTO=latestOnBlocks-f.block,latestCall=latestTO-CALL_BEFORE_TAKEOFF,safeAfter=Math.min(latestCall,hsbEnd),delta=futureDelta(safeAfter,now),safeReason=hsbEnd<latestCall?"HSB finish":"Latest call",fs=statuses[f.flight]||{status:"unknown",found:false,label:"Unknown",confidence:"none",safe_by_status:false};return{...f,latestOnBlocks,latestTO,latestCall,safeAfter,delta,safeReason,fs}});const live=computed.filter(f=>!hsbNotStarted&&!hsbFinished&&f.delta>=0&&!f.fs.safe_by_status);const aliveList=document.getElementById("aliveList");if(hsbNotStarted){aliveList.innerHTML="<div class='alive-title'>HSB not started yet</div><div class='tile pre'><div><strong>Standby starts at "+fmt(hsbStart)+"</strong></div><div class='call'>HSB finish "+fmt(hsbEnd)+"</div><div class='remaining'>starts in "+dur(hsbStartDelta)+"</div></div>"}else if(hsbFinished){aliveList.innerHTML="<div class='alive-title'>Still legal to operate</div><div class='safe'>HSB finished — no further flights can be allocated.</div>"}else if(!live.length){aliveList.innerHTML="<div class='alive-title'>Still legal to operate</div><div class='safe'>None remaining by time/status.</div>"}else{aliveList.innerHTML="<div class='alive-title'>Still legal to operate</div>"+live.map(f=>"<div class='tile "+(f.delta<=60?"critical":"live")+"'><div><strong>"+f.flight+" "+f.to+"</strong></div><div class='call'>Safe after "+fmt(f.safeAfter)+"</div><div class='remaining'>"+dur(f.delta)+"</div></div>").join("")}const rows=document.getElementById("rows");rows.innerHTML="";for(const f of computed){let statusClass="ok",reserveStatus="Live",countdown="in "+dur(f.delta),rowClass="";if(hsbNotStarted){statusClass="prestatus";reserveStatus="HSB not started";countdown="HSB starts in "+dur(hsbStartDelta);rowClass="row-pre"}if(f.fs.safe_by_status){statusClass="safe";reserveStatus="Safe — "+(f.fs.label||f.fs.status);countdown=f.fs.label||"Safe";rowClass="row-safe row-departed"}else if(f.fs.confidence==="uncertain"){statusClass="uncertain";if(!hsbNotStarted)rowClass="row-uncertain"}if(!f.fs.safe_by_status&&(hsbFinished||f.delta<0)){statusClass="safe";reserveStatus=hsbFinished||f.safeReason==="HSB finish"?"Safe — HSB finished":"Safe — latest call passed";countdown="Safe since "+fmt(hsbFinished?hsbEnd:f.safeAfter);rowClass="row-safe"}else if(!f.fs.safe_by_status&&!hsbNotStarted&&f.delta<=60){statusClass="amber";reserveStatus=f.safeReason==="HSB finish"?"Last chance — HSB ending":"Last chance"}const delay=f.fs.departure&&f.fs.departure.delay!=null?f.fs.departure.delay+"m":"—";const reg=f.fs.aircraft&&f.fs.aircraft.registration?f.fs.aircraft.registration:"—";const fsText=f.fs.found?(f.fs.label||f.fs.status):"unknown";const googleUrl="https://www.google.com/search?q="+encodeURIComponent(f.flight);const tr=document.createElement("tr");tr.className=rowClass;tr.innerHTML="<td><strong>"+f.flight+"</strong></td><td>"+reg+"</td><td>"+f.route+"</td><td>"+fmt(f.schedTO)+"</td><td>"+fmt(f.schedArr)+"</td><td>"+minToBlock(f.block)+"</td><td>"+fmt(f.latestOnBlocks)+"</td><td>"+fmt(f.latestTO)+"</td><td><span class='badge'>"+fmt(f.latestCall)+"</span></td><td><span class='badge'>"+fmt(f.safeAfter)+"</span><br><small>"+f.safeReason+"</small></td><td>"+fsText+"</td><td>"+(f.fs.confidence||"—")+"</td><td>"+delay+"</td><td>"+countdown+"</td><td class='"+statusClass+"'>"+reserveStatus+"</td><td><a class='status-link' target='_blank' rel='noopener' href='"+googleUrl+"'>Check</a></td>";rows.appendChild(tr)}}
document.getElementById("parseBtn").addEventListener("click",parseAndRender);document.getElementById("statusBtn").addEventListener("click",refreshStatus);document.getElementById("hsbStart").addEventListener("input",render);document.getElementById("hsbEnd").addEventListener("input",render);const saved=localStorage.getItem(STORAGE_KEY);if(saved)document.getElementById("ficoInput").value=saved;parseAndRender();setInterval(render,30000);setInterval(refreshStatus,60000);
</script></body></html>`;
}
