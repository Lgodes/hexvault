const WIZARDS_LOCATOR='https://locator.wizards.com/search';
const UA='Mozilla/5.0 (compatible; HexVaultEvents/1.0; +https://netlify.app)';

function json(statusCode,body,cache='no-store'){
  return {statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':cache,'access-control-allow-origin':'*'},body:JSON.stringify(body)};
}
function clean(v,max=500){return String(v??'').replace(/\s+/g,' ').trim().slice(0,max)}
function arr(v){return Array.isArray(v)?v:(v==null?[]:[v])}
function officialUrl(city,radius,dateFrom='',dateTo='',page=1){
  const u=new URL(WIZARDS_LOCATOR);u.searchParams.set('searchType','magic-events');u.searchParams.set('query',city);u.searchParams.set('distance',String(radius));u.searchParams.set('sort','date');u.searchParams.set('sortDirection','Asc');u.searchParams.set('page',String(page));
  if(dateFrom)u.searchParams.set('startDate',dateFrom);if(dateTo)u.searchParams.set('endDate',dateTo);return u.href;
}
function addressFrom(loc){
  if(!loc)return '';
  if(typeof loc==='string')return clean(loc);
  const a=loc.address||loc;
  if(typeof a==='string')return clean(a);
  return clean([a.streetAddress,a.addressLocality,a.addressRegion,a.postalCode,a.addressCountry].filter(Boolean).join(', '));
}
function normalizeEvent(raw,source='provider'){
  if(!raw||typeof raw!=='object')return null;
  const location=raw.location||raw.venue||raw.store||raw.organizer||{};
  const store=clean(raw.storeName||raw.venueName||raw.locationName||location.name||raw.organizer?.name||raw.store||'');
  const name=clean(raw.name||raw.title||raw.eventName||raw.event_name||'Magic event');
  const start=clean(raw.startDate||raw.start_date||raw.start||raw.dateTime||raw.datetime||raw.date||'');
  const url=clean(raw.url||raw.eventUrl||raw.event_url||raw.registrationUrl||raw.registration_url||raw.link||'');
  const format=clean(raw.format||raw.formatName||raw.eventType||raw.event_type||raw.playFormat||'Magic');
  const address=addressFrom(raw.address||location.address||raw.location);
  const distance=raw.distanceKm??raw.distance_km??raw.distance;
  const capacity=raw.maximumAttendeeCapacity??raw.capacity??raw.playerCapacity??raw.player_capacity;
  if(!name&&!store)return null;
  return {id:clean(raw.id||raw.eventId||raw.event_id||`${name}-${start}-${store}`,180),name,store,address,start,format,url,distanceKm:Number.isFinite(Number(distance))?Number(distance):null,capacity:capacity==null?null:Number(capacity)||clean(capacity,30),source,sourceLabel:source==='wizards'?'WIZARDS LOCATOR':'LIVE EVENT'};
}
function formatMatches(e,formats){if(!formats.length)return true;const hay=`${e.name} ${e.format}`.toLowerCase();return formats.some(f=>hay.includes(f.toLowerCase().replace('two-headed giant','two-headed')))}
function walk(value,out,depth=0){
  if(depth>12||value==null)return;
  if(Array.isArray(value)){for(const v of value)walk(v,out,depth+1);return}
  if(typeof value!=='object')return;
  const keys=Object.keys(value).map(k=>k.toLowerCase());
  const looksEvent=keys.some(k=>['startdate','start_date','eventdate','eventname','event_name','eventid','event_id'].includes(k))||(keys.includes('name')&&keys.some(k=>k.includes('date'))&&keys.some(k=>k.includes('location')||k.includes('venue')||k.includes('store')));
  if(looksEvent){const n=normalizeEvent(value,'wizards');if(n)out.push(n)}
  for(const v of Object.values(value))walk(v,out,depth+1);
}
function parseJsonScripts(html){
  const out=[];
  for(const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{const d=JSON.parse(m[1]);walk(d,out)}catch{}
  }
  for(const m of html.matchAll(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{walk(JSON.parse(m[1]),out)}catch{}
  }
  return out;
}
function parseRouterEvents(html,searchUrl){
  try{
    const match=String(html).match(/streamController\.enqueue\(("[\s\S]*?")\);<\/script>/);if(!match)return [];
    const flat=JSON.parse(JSON.parse(match[1])),seen=new Map();
    const decode=index=>{
      if(index===-1)return undefined;if(index===-2)return NaN;if(index===-3)return Infinity;if(index===-4)return-Infinity;if(index<0)return null;if(seen.has(index))return seen.get(index);
      const value=flat[index];if(value===null||typeof value!=='object')return value;
      if(Array.isArray(value)){const result=[];seen.set(index,result);for(const item of value)result.push(typeof item==='number'?decode(item):item);return result}
      const result={};seen.set(index,result);for(const [encoded,item] of Object.entries(value)){const key=encoded.startsWith('_')?decode(Number(encoded.slice(1))):encoded;result[key]=typeof item==='number'?decode(item):item}return result;
    };
    const root=decode(0),route=root?.loaderData?.['routes/($lang).search'];
    // Wizards currently nests search rows here. Retain the older array form as a fallback.
    const rows=Array.isArray(route?.events)?route.events:
      Array.isArray(route?.events?.advancedSearchEvents?.events)?route.events.advancedSearchEvents.events:[];
    return rows.map(raw=>{
      const org=raw.organization||{},format=raw.eventFormat?.name||inferredFormat(raw.title),start=clean(raw.scheduledStartTime,80),timeZone=clean(raw.timeZone,80)||'UTC';
      let dateLabel='';try{dateLabel=new Intl.DateTimeFormat('en-GB',{timeZone,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(start))}catch{}
      const url=new URL(searchUrl);url.searchParams.set('eventId',String(raw.id||''));
      return {id:clean(raw.id,180),name:clean(raw.title)||'Magic event',store:clean(org.name)||'Local game store',address:clean([org.address,org.city,org.postalCode].filter(Boolean).join(', ')),start,dateLabel,format:clean(format)||'Magic',url:url.href,storeUrl:org.id?new URL(`/store/${org.id}`,searchUrl).href:'',distanceKm:Number.isFinite(Number(raw.distance))?Number(raw.distance)/1000:null,capacity:raw.capacity==null?null:Number(raw.capacity)||null,timeZone,source:'wizards',sourceLabel:'WIZARDS LOCATOR'};
    }).filter(event=>event.id&&event.name);
  }catch{return []}
}
function decodeHtml(value){
  return clean(String(value??'')
    .replace(/<!--\s*-->/g,'')
    .replace(/<[^>]*>/g,' ')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' '),500);
}
function attr(block,name){
  const m=String(block).match(new RegExp(`${name}=["']([^"']+)["']`,'i'));
  return m?m[1].replace(/&amp;/g,'&'):'';
}
function testText(block,testId){
  const re=new RegExp(`<[^>]+data-testid=["']${testId}["'][^>]*>([\\s\\S]*?)(?=<[^>]+data-testid=|<\\/div>)`,'i');
  const m=String(block).match(re);return m?decodeHtml(m[1]):'';
}
function inferredFormat(name){
  const n=String(name||'').toLowerCase();
  const formats=['Commander','Pauper','Standard','Modern','Pioneer','Legacy','Vintage','Draft','Sealed','Two-Headed Giant'];
  return formats.find(f=>n.includes(f.toLowerCase().replace('two-headed giant','two-headed')))||'Magic';
}
function locatorDate(value){
  const text=clean(value,80),m=text.match(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),?\s+([A-Za-z]{3})\s+(\d{1,2})/i);if(!m)return {iso:'',label:text};
  const months={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11},month=months[m[1].toLowerCase()];if(month==null)return {iso:'',label:text};
  const now=new Date(),candidate=new Date(now.getFullYear(),month,Number(m[2]),12,0,0);if(candidate.getTime()<now.getTime()-7*86400000)candidate.setFullYear(candidate.getFullYear()+1);
  return {iso:`${candidate.getFullYear()}-${String(candidate.getMonth()+1).padStart(2,'0')}-${String(candidate.getDate()).padStart(2,'0')}T12:00:00`,label:text};
}
function parseRenderedEvents(html,searchUrl){
  const parts=String(html).split(/(?=<[^>]+data-testid=["']searchResultsEventItem["'])/i).slice(1),out=[];
  for(const part of parts){
    const block=part.split(/(?=<[^>]+data-testid=["']searchResultsEventItem["']|<script)/i)[0];
    const titleMatch=block.match(/data-testid=["']eventCardTitle["'][\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!titleMatch)continue;
    const name=decodeHtml(titleMatch[2]),href=titleMatch[1].replace(/&amp;/g,'&');
    const eventId=(href.match(/[?&]eventId=([^&]+)/)||[])[1]||'';
    const store=testText(block,'eventCardLocationLink');
    const date=locatorDate(testText(block,'eventCardDate'));
    const distanceText=testText(block,'eventCardDistance');
    const distanceNumber=parseFloat(distanceText.replace(',','.'));
    const distanceKm=Number.isFinite(distanceNumber)?(distanceText.toLowerCase().includes('mi')?distanceNumber*1.609344:distanceNumber):null;
    const storeHref=(block.match(/data-testid=["']eventCardLocationLink["'][^>]+href=["']([^"']+)/i)||[])[1]||'';
    out.push({
      id:eventId||`${name}-${date.iso||date.label}-${store}`,name,store,address:'',start:date.iso,dateLabel:date.label,
      format:inferredFormat(name),distanceKm,url:new URL(href,searchUrl).href,
      storeUrl:storeHref?new URL(storeHref,searchUrl).href:'',source:'wizards',sourceLabel:'WIZARDS LOCATOR'
    });
  }
  return dedupe(out);
}
function dedupe(events){const seen=new Set();return events.filter(e=>{const k=(e.id?`id:${e.id}`:`${e.name}|${e.start}|${e.store}`).toLowerCase();if(seen.has(k))return false;seen.add(k);return true})}
async function customProvider(city,radius,formats,dateFrom='',dateTo=''){
  const base=process.env.ARCANA_EVENTS_API_URL;if(!base)return null;
  const u=new URL(base);u.searchParams.set('city',city);u.searchParams.set('radius',String(radius));if(dateFrom)u.searchParams.set('dateFrom',dateFrom);if(dateTo)u.searchParams.set('dateTo',dateTo);for(const f of formats)u.searchParams.append('format',f);
  const headers={accept:'application/json'};if(process.env.ARCANA_EVENTS_API_KEY)headers.authorization=`Bearer ${process.env.ARCANA_EVENTS_API_KEY}`;
  const r=await fetch(u,{headers});if(!r.ok)throw new Error(`Configured event provider returned HTTP ${r.status}`);
  const data=await r.json();const rows=Array.isArray(data)?data:(data.events||data.results||data.data||[]);
  return dedupe(arr(rows).map(x=>normalizeEvent(x,'provider')).filter(Boolean).filter(e=>formatMatches(e,formats))).slice(0,80);
}
function eventLocalDateKey(event){
  const start=event?.start;if(!start)return '';
  const date=new Date(start);if(Number.isNaN(date.getTime()))return String(start).slice(0,10);
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:event.timeZone||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
    const get=type=>parts.find(part=>part.type===type)?.value||'';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }catch{return String(start).slice(0,10)}
}
function withinDates(event,dateFrom,dateTo){const key=eventLocalDateKey(event);if(!key)return !dateFrom&&!dateTo;return (!dateFrom||key>=dateFrom)&&(!dateTo||key<=dateTo)}
async function wizardsProvider(city,radius,formats,dateFrom='',dateTo=''){
  const firstUrl=officialUrl(city,radius,dateFrom,dateTo,1),pages=(dateFrom||dateTo)?4:1,all=[];
  for(let page=1;page<=pages;page++){
    const url=officialUrl(city,radius,dateFrom,dateTo,page),r=await fetch(url,{headers:{'user-agent':UA,accept:'text/html,application/xhtml+xml','accept-language':'en-US,en;q=0.9'}});
    if(!r.ok){if(page===1)throw new Error(`Wizards locator returned HTTP ${r.status}`);break}
    const html=await r.text(),hydrated=parseRouterEvents(html,url),rendered=parseRenderedEvents(html,url);all.push(...hydrated,...rendered,...parseJsonScripts(html));
    if(rendered.length<10)break;
  }
  const events=dedupe(all).filter(e=>withinDates(e,dateFrom,dateTo)).filter(e=>formatMatches(e,formats)).slice(0,80);
  return {events,url:firstUrl};
}
export async function handler(event){
  if(event.httpMethod==='OPTIONS')return json(204,{});
  if(event.httpMethod!=='GET')return json(405,{error:'Method not allowed'});
  const q=event.queryStringParameters||{};const multi=event.multiValueQueryStringParameters||{};
  const city=clean(q.city,160);if(!city)return json(400,{error:'City is required'});
  const radius=Math.max(1,Math.min(200,Number(q.radius)||25));
  const dateFrom=/^\d{4}-\d{2}-\d{2}$/.test(q.dateFrom||'')?q.dateFrom:'';
  const dateTo=/^\d{4}-\d{2}-\d{2}$/.test(q.dateTo||'')?q.dateTo:'';
  const formats=arr(multi.format?.length?multi.format:q.format).map(x=>clean(x,60)).filter(Boolean).slice(0,12);
  const officialSearchUrl=officialUrl(city,radius,dateFrom,dateTo);
  try{
    const custom=await customProvider(city,radius,formats,dateFrom,dateTo);
    if(custom)return json(200,{events:custom,provider:'configured',officialSearchUrl,note:'Results supplied by the configured HexVault event provider. Confirm details with the organizer.'},'public, max-age=120, stale-while-revalidate=300');
  }catch(e){return json(502,{events:[],provider:'configured',officialSearchUrl,message:e.message})}
  try{
    const w=await wizardsProvider(city,radius,formats,dateFrom,dateTo);
    if(w.events.length)return json(200,{events:w.events,provider:'wizards',officialSearchUrl:w.url,note:'Listings parsed from the public Wizards Store & Event Locator. Confirm event details before travelling.'},'public, max-age=120, stale-while-revalidate=300');
    return json(200,{events:[],provider:'wizards',officialSearchUrl:w.url,message:'The Wizards locator page was reachable, but HexVault could not extract structured event listings from it. Use the official locator link below.'},'public, max-age=60');
  }catch(e){
    return json(200,{events:[],provider:'wizards-unavailable',officialSearchUrl,message:'Wizards does not currently expose a documented public event API, and its locator blocked or did not expose structured data to the HexVault proxy. The in-app Events UI is ready for an approved JSON provider.'},'public, max-age=60');
  }
}
