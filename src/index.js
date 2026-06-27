const DEFAULT_FICO = `FLIGHT NO   FROM TO  PTD     ETD    PTA   ETA CFG  RGN  RMKS
207    LHR-MIA 0855   P  @0   1830 P -20  A8J69 LEK
285    LHR-SFO 0945   P  @0   2050 P -17  A8J69 LEE
193    LHR-DFW 1155   P  @0   2205 P -24  A8J69 LEH
269    LHR-LAX 1405   ?  @0   0120 ?  @0  A8J69 LEC
055    LHR-JNB 1800   ?  @0   0500 ?  @0  A8J69 LED
057    LHR-JNB 2020   P  @0   0725 P  @0  A8J69 LEA`;

const MONTHLY_CAP_USD = 8.00;
const COST_PER_FLIGHT_USD = 0.005;
const CACHE_TTL_SECONDS = 600;

export default {async fetch(request, env) {const url = new URL(request.url); if (url.pathname === "/api/status") return handleStatus(request, env); if (url.pathname === "/api/usage") return handleUsage(env); return new Response(appHtml(), {headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});}};

async function handleUsage(env){return jsonResponse(await getUsageGuard(env));}

async function handleStatus(request, env){
  const url = new URL(request.url);
  if(!env.FLIGHTAWARE_API_KEY) return jsonResponse({ok:false,blocked:true,error:"Missing FLIGHTAWARE_API_KEY secret"},500);
  if(!env.USAGE_KV) return jsonResponse({ok:false,blocked:true,error:"Missing USAGE_KV binding. Paid AeroAPI calls blocked for safety."},500);
  const requestedFlights=(url.searchParams.get("flights")||"").split(",").map(normaliseFlight).filter(Boolean);
  if(!requestedFlights.length) return jsonResponse({ok:false,error:"No flights supplied"},400);
  const monthKey=usageMonthKey(), usageKey=`usage:${monthKey}`, cachePrefix=`cache:${monthKey}:`, usage=await readUsage(env,usageKey), results={}, toFetch=[];
  for(const flight of requestedFlights){const cached=await readFlightCache(env,cachePrefix+flight); if(cached) results[flight]={...cached,cache:"hit"}; else toFetch.push(flight);}
  const estimatedCost=roundMoney(toFetch.length*COST_PER_FLIGHT_USD), projectedCost=roundMoney(usage.cost_usd+estimatedCost);
  if(projectedCost>MONTHLY_CAP_USD) return jsonResponse({ok:false,blocked:true,error:"Monthly AeroAPI app cap would be exceeded. No paid calls made.",month:monthKey,cap_usd:MONTHLY_CAP_USD,used_usd:usage.cost_usd,estimated_cost_usd:estimatedCost,projected_cost_usd:projectedCost,cached_results:Object.keys(results).length,paid_calls_blocked:toFetch.length,flights:results},402);
  let paidCalls=0,lastError=null;
  for(const flight of toFetch){try{const fa=await fetchFlightAware(flight,env.FLIGHTAWARE_API_KEY);const mapped=mapFlightAware(flight,fa);results[flight]=mapped;await writeFlightCache(env,cachePrefix+flight,mapped);paidCalls++;}catch(err){lastError=String(err);results[flight]=emptyFlight(flight,lastError);}}
  if(paidCalls>0){usage.calls+=paidCalls;usage.cost_usd=roundMoney(usage.cost_usd+paidCalls*COST_PER_FLIGHT_USD);usage.updated=new Date().toISOString();await writeUsage(env,usageKey,usage);}
  return jsonResponse({ok:true,version:"v10",source:"flightaware_aeroapi",updated:new Date().toISOString(),month:monthKey,cap_usd:MONTHLY_CAP_USD,used_usd:usage.cost_usd,paid_calls_this_refresh:paidCalls,estimated_cost_this_refresh_usd:roundMoney(paidCalls*COST_PER_FLIGHT_USD),cache_ttl_seconds:CACHE_TTL_SECONDS,last_error:lastError,flights:results});
}

async function fetchFlightAware(flight,apiKey){const url=new URL(`https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flight)}`);url.searchParams.set("max_pages","1");const response=await fetch(url.toString(),{headers:{"x-apikey":apiKey,"Accept":"application/json"}});if(!response.ok){const text=await response.text();throw new Error(`AeroAPI ${response.status}: ${text.slice(0,200)}`);}return response.json();}
function mapFlightAware(requestedFlight,data){const flights=Array.isArray(data?.flights)?data.flights:[],best=pickFlightAwareRecord(flights,requestedFlight);if(!best)return emptyFlight(requestedFlight,"No AeroAPI flight record returned");const status=classifyFlightAware(best);return {flight:requestedFlight,found:true,status:status.status,label:status.label,confidence:status.confidence,safe_by_status:status.safe_by_status,raw_status:best.status||null,ident:best.ident||null,fa_flight_id:best.fa_flight_id||null,scheduled_out:best.scheduled_out||null,estimated_out:best.estimated_out||null,actual_out:best.actual_out||null,scheduled_off:best.scheduled_off||null,estimated_off:best.estimated_off||null,actual_off:best.actual_off||null,scheduled_on:best.scheduled_on||null,estimated_on:best.estimated_on||null,actual_on:best.actual_on||null,scheduled_in:best.scheduled_in||null,estimated_in:best.estimated_in||null,actual_in:best.actual_in||null,origin:best.origin||null,destination:best.destination||null,progress_percent:best.progress_percent??null,cache:"miss"};}
function pickFlightAwareRecord(flights,requestedFlight){if(!flights.length)return null;const today=new Date().toISOString().slice(0,10),candidates=flights;const todayish=candidates.filter(f=>{const t=f.scheduled_out||f.estimated_out||f.actual_out||f.scheduled_off||f.estimated_off||f.actual_off;return t?String(t).slice(0,10)===today:false;});return (todayish.length?todayish:candidates).sort((a,b)=>{const ta=Date.parse(a.scheduled_out||a.estimated_out||a.actual_out||a.scheduled_off||"")||0,tb=Date.parse(b.scheduled_out||b.estimated_out||b.actual_out||b.scheduled_off||"")||0;return Math.abs(Date.now()-ta)-Math.abs(Date.now()-tb);})[0];}
function classifyFlightAware(f){const s=String(f.status||"").toLowerCase();if(s.includes("cancel"))return{status:"cancelled",label:"Cancelled",confidence:"confirmed",safe_by_status:true};if(s.includes("divert"))return{status:"diverted",label:"Diverted",confidence:"confirmed",safe_by_status:true};const hasDepartedEvidence=Boolean(f.actual_out||f.actual_off||f.actual_on||f.actual_in);if(hasDepartedEvidence||s.includes("airborne")||s.includes("en route")||s.includes("enroute")||s.includes("departed")||s.includes("arrived")||s.includes("landed"))return{status:"departed",label:"Departed",confidence:"confirmed",safe_by_status:true};const scheduled=Date.parse(f.scheduled_out||f.scheduled_off||""),estimated=Date.parse(f.estimated_out||f.estimated_off||""),pastSTD=scheduled?Date.now()>scheduled:false,estimatedLater=scheduled&&estimated?estimated>scheduled:false;if(s.includes("delay")||pastSTD||estimatedLater)return{status:"delayed",label:"Delayed",confidence:"aeroapi",safe_by_status:false};if(s.includes("scheduled")||s.includes("planned")||scheduled)return{status:"planned",label:"Planned",confidence:"aeroapi",safe_by_status:false};return{status:"unknown",label:"Unknown",confidence:"unknown",safe_by_status:false};}
function emptyFlight(flight,error=null){return{flight,found:false,status:"unknown",label:"Unknown",confidence:"none",safe_by_status:false,error,cache:"none"};}
async function getUsageGuard(env){if(!env.USAGE_KV)return{ok:false,blocked:true,error:"Missing USAGE_KV binding",cap_usd:MONTHLY_CAP_USD,used_usd:null};const usage=await readUsage(env,`usage:${usageMonthKey()}`);return{ok:true,month:usageMonthKey(),cap_usd:MONTHLY_CAP_USD,used_usd:usage.cost_usd,calls:usage.calls,remaining_usd:roundMoney(Math.max(0,MONTHLY_CAP_USD-usage.cost_usd)),cost_per_flight_usd:COST_PER_FLIGHT_USD,cache_ttl_seconds:CACHE_TTL_SECONDS};}
async function readUsage(env,key){const existing=await env.USAGE_KV.get(key,"json");if(existing&&typeof existing.cost_usd==="number")return existing;return{month:usageMonthKey(),calls:0,cost_usd:0,updated:null};}
async function writeUsage(env,key,usage){await env.USAGE_KV.put(key,JSON.stringify(usage),{expirationTtl:60*60*24*370});}
async function readFlightCache(env,key){const cached=await env.USAGE_KV.get(key,"json");if(!cached||!cached.saved_at||!cached.data)return null;const ageSeconds=(Date.now()-Date.parse(cached.saved_at))/1000;if(ageSeconds>CACHE_TTL_SECONDS)return null;return cached.data;}
async function writeFlightCache(env,key,data){await env.USAGE_KV.put(key,JSON.stringify({saved_at:new Date().toISOString(),data}),{expirationTtl:CACHE_TTL_SECONDS+60});}
function usageMonthKey(){const d=new Date();return d.getUTCFullYear()+"-"+String(d.getUTCMonth()+1).padStart(2,"0");}
function roundMoney(n){return Math.round((Number(n)+Number.EPSILON)*1000)/1000;}
function normaliseFlight(value){return String(value||"").replace(/\s+/g,"").toUpperCase();}
function jsonResponse(body,status=200){return new Response(JSON.stringify(body,null,2),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type"}});}

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
.top-safe{border-color:rgba(65,212,90,.65)}
.top-pre{border-color:rgba(88,166,255,.65)}
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
.top-safe .callable-head{color:var(--green)}
.top-pre .callable-head{color:var(--blue)}
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
.guard{padding:12px 14px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}.guard strong{color:var(--amber)}.guard .ok{color:var(--green)}.guard .bad{color:var(--red)}
.fico{padding:14px 16px}
.fico-grid{display:grid;grid-template-columns:1fr 230px;gap:14px}
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
@media(max-width:800px){.guard{grid-template-columns:1fr}
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
    <h1>HSB Reserve App <span class="version">v10.1</span></h1>
    <p class="sub">All times in Zulu (Z). Manual FlightAware refresh only. Monthly app cap: $8.</p>
  </div>
  <div class="controls">
    <div class="control"><label for="hsbStart">HSB start</label><input id="hsbStart" type="time" value="12:00"></div>
    <div class="control"><label for="hsbEnd">HSB finish</label><input id="hsbEnd" type="time" value="20:00"></div>
    <div class="control"><label>UTC</label><div class="clock" id="utcClock">----Z</div></div>
  </div>
</section>

<section class="card guard"><div id="usageGuard">Loading usage guard...</div><div><button id="usageBtn">Check usage</button></div></section>

<section class="card fico">
  <div class="fico-grid">
    <div>
      <label for="ficoInput">Paste BA/FICO flight list</label>
      <textarea id="ficoInput" spellcheck="false">${escapedFico}</textarea>
    </div>
    <div class="button-col">
      <button class="primary" id="parseBtn">Parse FICO list</button>
      <button id="statusBtn">Refresh live status</button>
      <div id="parseNote" class="parse-note">No automatic paid polling. Tomorrow rows such as 207/27 are ignored.</div>
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
  <div class="note">Call by = earlier of latest legal call time or HSB finish. Rows remain chronological by scheduled take-off. FlightAware is only queried when you press Refresh live status.</div>
</section>
</main>

<script>
let flights=[];let statuses={};let lastStatusUpdate=null;let usageGuard=null;
const HSB_TO_CHOCKS_LIMIT=1140,CALL_BEFORE_TAKEOFF=120,COST_PER_FLIGHT_USD=0.005,STORAGE_KEY="hsb-reserve-fico-v10-1";
function toMin(t){const p=t.split(":").map(Number);return p[0]*60+p[1]}
function compactToMin(s){s=String(s).replace(/\D/g,"").padStart(4,"0");return Number(s.slice(0,2))*60+Number(s.slice(2,4))}
function minToBlock(mins){mins=Math.abs(mins);return String(Math.floor(mins/60)).padStart(2,"0")+":"+String(mins%60).padStart(2,"0")}
function fmt(mins){const plus=mins>=1440?" +1":"";mins=((mins%1440)+1440)%1440;return String(Math.floor(mins/60)).padStart(2,"0")+String(mins%60).padStart(2,"0")+"Z"+plus}
function fmtShort(mins){return fmt(mins).replace("Z","")}
function dur(mins){mins=Math.max(0,Math.abs(mins));return Math.floor(mins/60)+"h "+String(mins%60).padStart(2,"0")+"m"}
function money(n){return "$"+Number(n||0).toFixed(3)}
function utcNowMinutes(){const d=new Date();return d.getUTCHours()*60+d.getUTCMinutes()}
function utcNowText(){const d=new Date();return String(d.getUTCHours()).padStart(2,"0")+String(d.getUTCMinutes()).padStart(2,"0")+"Z"}
function futureDelta(targetMins,nowMins){let target=targetMins;while(target<nowMins-720)target+=1440;return target-nowMins}
function normaliseEnd(start,end){return end<=start?end+1440:end}
function parseFico(text){const parsed=[];for(const rawLine of text.split(/\n/)){const line=rawLine.trim();if(line.match(/^\d{3}\/\d{1,2}/))continue;const m=line.match(/^(\d{3})\s+([A-Z]{3})-([A-Z]{3})\s+(\d{4})\S*\s+\S+\s+\S+\s+(\d{4})/);if(!m)continue;const[,num,from,to,ptd,pta]=m;const schedTO=compactToMin(ptd);let schedArr=compactToMin(pta);if(schedArr<=schedTO)schedArr+=1440;parsed.push({flight:"BA"+num,from,to,route:from+"-"+to,schedTO,schedArr,block:schedArr-schedTO})}return parsed.sort((a,b)=>a.schedTO-b.schedTO)}
async function checkUsage(){const el=document.getElementById("usageGuard");try{const res=await fetch("/api/usage");const data=await res.json();usageGuard=data;if(!data.ok){el.innerHTML="<strong class='bad'>AeroAPI blocked:</strong> "+(data.error||"usage guard unavailable");return}el.innerHTML="<strong class='ok'>AeroAPI guard active.</strong> Used this month: <strong>"+money(data.used_usd)+"</strong> / $"+Number(data.cap_usd).toFixed(2)+". Remaining app allowance: <strong>"+money(data.remaining_usd)+"</strong>. Cache: "+Math.round(data.cache_ttl_seconds/60)+" min."}catch(e){usageGuard=null;el.innerHTML="<strong class='bad'>AeroAPI blocked:</strong> usage check failed."}}
async function refreshStatus(){if(!flights.length)return;await checkUsage();if(!usageGuard||!usageGuard.ok){document.getElementById("parseNote").textContent="Live refresh blocked: usage guard unavailable.";return}const estimated=flights.length*COST_PER_FLIGHT_USD;const msg="Refresh live status for "+flights.length+" flights? Estimated maximum cost "+money(estimated)+". Cached results may cost less. Monthly app cap is $"+Number(usageGuard.cap_usd).toFixed(2)+".";if(!confirm(msg)){document.getElementById("parseNote").textContent="Live refresh cancelled. No AeroAPI calls made.";return}const query=flights.map(f=>f.flight).join(",");try{const res=await fetch("/api/status?flights="+encodeURIComponent(query));const data=await res.json();if(data.ok&&data.flights){statuses=data.flights;lastStatusUpdate=new Date(data.updated);document.getElementById("parseNote").textContent="Updated: "+lastStatusUpdate.toUTCString()+". Paid calls this refresh: "+data.paid_calls_this_refresh+". Estimated cost: "+money(data.estimated_cost_this_refresh_usd)+". Used this month: "+money(data.used_usd)+"."}else{document.getElementById("parseNote").textContent="Live refresh blocked/error: "+(data.error||"unknown")}}catch(e){document.getElementById("parseNote").textContent="Live status fetch failed: "+e}await checkUsage();render()}
function parseAndRender(){const text=document.getElementById("ficoInput").value;localStorage.setItem(STORAGE_KEY,text);flights=parseFico(text);statuses={};document.getElementById("parseNote").textContent="Parsed "+flights.length+" flights. Live status not refreshed. Estimated max refresh cost: "+money(flights.length*COST_PER_FLIGHT_USD)+".";render()}
function computeRows(){const startInput=document.getElementById("hsbStart").value,endInput=document.getElementById("hsbEnd").value;if(!startInput||!endInput)return null;const hsbStart=toMin(startInput),hsbEnd=normaliseEnd(hsbStart,toMin(endInput)),latestOnBlocks=hsbStart+HSB_TO_CHOCKS_LIMIT,now=utcNowMinutes(),hsbStartDelta=futureDelta(hsbStart,now),hsbFinishDelta=futureDelta(hsbEnd,now),hsbNotStarted=hsbStartDelta>0&&hsbStartDelta<720,hsbFinished=hsbFinishDelta<0;const rows=flights.map(f=>{const latestTO=latestOnBlocks-f.block,latestCall=latestTO-CALL_BEFORE_TAKEOFF,callBy=Math.min(latestCall,hsbEnd),callByReason=hsbEnd<latestCall?"HSB finish":"Latest call",delta=futureDelta(callBy,now),fs=statuses[f.flight]||{status:"no_live_refresh",found:false,label:null,confidence:"none",safe_by_status:false};return{...f,latestOnBlocks,latestTO,latestCall,callBy,callByReason,delta,fs}});return{rows,hsbStart,hsbEnd,latestOnBlocks,now,hsbStartDelta,hsbFinishDelta,hsbNotStarted,hsbFinished}}
function apiHasUsefulStatus(f){return f.fs&&f.fs.found&&f.fs.label&&f.fs.label!=="Unknown"}
function operationalStatus(f,state){if(f.fs&&f.fs.safe_by_status)return f.fs.label||"Departed";if(state.hsbFinished||f.delta<0)return"Safe";if(apiHasUsefulStatus(f))return f.fs.label;if(state.now>=f.schedTO)return"Delayed";return"Planned"}
function isSafe(f,state){return(f.fs&&f.fs.safe_by_status)||state.hsbFinished||f.delta<0}
function isUnknown(f,state){return operationalStatus(f,state)==="Unknown"}
function dotClassFor(f,state){if(state.hsbNotStarted)return"dot-blue";if(isSafe(f,state))return"dot-green";if(isUnknown(f,state))return"dot-grey";if(f.delta<=30)return"dot-red";return"dot-amber"}
function rowClassFor(f,state){if(state.hsbNotStarted)return"row-pre";if(isSafe(f,state))return f.fs&&f.fs.safe_by_status?"row-departed":"row-safe";if(f.delta<=30)return"row-critical";return"row-live"}
function statusClass(f,state){const s=operationalStatus(f,state);if(s==="Planned")return"status-planned";if(s==="Delayed")return"status-delayed";if(s==="Safe"||s==="Departed"||s==="Cancelled"||s==="Diverted")return"status-safe";if(s==="Unknown")return"status-unknown";return"status-live"}
function countdownText(f,state){if(state.hsbNotStarted)return"HSB starts "+dur(state.hsbStartDelta);if(isSafe(f,state))return"Safe";return dur(f.delta)+" left"}
function render(){const clock=document.getElementById("utcClock");if(clock)clock.textContent=utcNowText();const state=computeRows();if(!state)return;renderTable(state)}
function renderTable(state){const rowsEl=document.getElementById("rows");rowsEl.innerHTML="";for(const f of state.rows){const googleUrl="https://www.google.com/search?q="+encodeURIComponent(f.flight),callBadge=isSafe(f,state)?"badge-green":"badge-amber",tr=document.createElement("tr");tr.className=rowClassFor(f,state);tr.innerHTML="<td><span class='dot "+dotClassFor(f,state)+"'></span></td><td><strong>"+f.flight+"</strong></td><td>"+f.route+"</td><td>"+fmtShort(f.schedTO)+"</td><td>"+fmtShort(f.schedArr)+"</td><td>"+minToBlock(f.block)+"</td><td><span class='badge "+callBadge+"'>"+fmt(f.callBy)+"</span><span class='small'>"+f.callByReason+"</span></td><td class='"+statusClass(f,state)+"'>"+operationalStatus(f,state)+"</td><td>"+countdownText(f,state)+"</td><td><a class='status-link' target='_blank' rel='noopener' href='"+googleUrl+"'>Check</a></td>";rowsEl.appendChild(tr)}}
document.getElementById("parseBtn").addEventListener("click",parseAndRender);document.getElementById("statusBtn").addEventListener("click",refreshStatus);document.getElementById("usageBtn").addEventListener("click",checkUsage);document.getElementById("hsbStart").addEventListener("input",render);document.getElementById("hsbEnd").addEventListener("input",render);try{const saved=localStorage.getItem(STORAGE_KEY);if(saved)document.getElementById("ficoInput").value=saved;parseAndRender();checkUsage();setInterval(render,10000)}catch(e){const guard=document.getElementById("usageGuard");if(guard)guard.innerHTML="<strong class='bad'>Frontend startup error:</strong> "+String(e);const clock=document.getElementById("utcClock");if(clock)clock.textContent="ERROR"}
</script>
</body>
</html>`;
}
