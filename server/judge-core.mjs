const RULES_HUB = 'https://magic.wizards.com/en/rules';
const MAX_SOURCE = 900000;

function json(statusCode, body){return {statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},body:JSON.stringify(body)}}
function extractOutput(data){if(data.output_text)return data.output_text;for(const item of data.output||[])for(const c of item.content||[])if(c.type==='output_text'&&c.text)return c.text;return ''}
function extractWebCitations(data){
  const found=[];
  for(const item of data.output||[])for(const content of item.content||[])for(const a of content.annotations||[]){
    const url=a.url||a.url_citation?.url,title=a.title||a.url_citation?.title;
    if(url&&!found.some(x=>x.url===url))found.push({label:title||'Supporting web source',section:'Supporting context',url});
  }
  return found.slice(0,6);
}
function parseJudgeOutput(value=''){
  const text=String(value).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(text)}catch{}
  const start=text.indexOf('{'),end=text.lastIndexOf('}');
  if(start>=0&&end>start)return JSON.parse(text.slice(start,end+1));
  throw new Error('No JSON object in Judge response');
}
function decodeHtml(s=''){return s.replace(/&amp;/g,'&').replace(/&#x2F;/gi,'/').replace(/&quot;/g,'"').replace(/&#39;/g,"'")}
async function fetchText(url){const r=await fetch(url,{headers:{'user-agent':'HexVaultRules/2.0 (+rules assistant)'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return (await r.text()).slice(0,MAX_SOURCE)}
async function currentComprehensiveRules(){
  const html=await fetchText(RULES_HUB);
  const links=[...html.matchAll(/href=["']([^"']+)["'][^>]*>(?:\s*<[^>]+>)*\s*TXT\s*/gi)].map(m=>decodeHtml(m[1]));
  let url=links[0];
  if(!url){const candidates=[...html.matchAll(/https?:\/\/media\.wizards\.com\/[^"'<>\s]+/gi)].map(m=>decodeHtml(m[0]));url=candidates.find(x=>/MagicCompRules|\.txt(?:\?|$)/i.test(x));}
  if(!url) throw new Error('Current Comprehensive Rules TXT link not found on Wizards rules hub');
  if(url.startsWith('/')) url=new URL(url,RULES_HUB).href;
  return {url,text:await fetchText(url)};
}
function terms(q){const stop=new Set('the a an and or to of in on at for from with without is are was were be been being do does did what when where who why how can could would should i me my you your it this that these those have has had if then than as by about game magic mtg card cards'.split(' '));return [...new Set((q.toLowerCase().match(/[a-z0-9+\-/]{3,}/g)||[]).filter(x=>!stop.has(x)))].slice(0,30)}
function retrieve(text,q){
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); const ts=terms(q);
  const scored=[];
  for(let i=0;i<lines.length;i++){
    const hay=(lines.slice(Math.max(0,i-2),Math.min(lines.length,i+5)).join(' ')).toLowerCase();
    let score=0; for(const t of ts){if(hay.includes(t))score+=t.length>7?3:2;}
    if(/\b(time|draw|tie|life|score|match|round|tournament|two-headed|commander|priority|stack|combat|damage|win|lose|loses|wins)\b/i.test(q) && /\b(win|lose|draw|life|priority|stack|combat|damage|multiplayer|commander|two-headed)\b/i.test(hay)) score+=1;
    if(score>0) scored.push({i,score});
  }
  scored.sort((a,b)=>b.score-a.score); const picked=[]; const used=[];
  for(const s of scored){if(used.some(i=>Math.abs(i-s.i)<9))continue;used.push(s.i);picked.push(lines.slice(Math.max(0,s.i-4),Math.min(lines.length,s.i+10)).join('\n'));if(picked.length>=7)break;}
  return picked.join('\n\n--- relevant rules excerpt ---\n\n').slice(0,24000);
}
function attachedCards(body){const cards=Array.isArray(body.cards)?body.cards:[];return cards.slice(0,12).map(c=>({name:String(c.name||'').slice(0,120),oracle_text:String(c.oracle_text||c.oracle||c.text||'').slice(0,1800),type_line:String(c.type_line||c.type||'').slice(0,300)})).filter(c=>c.name||c.oracle_text)}

export async function handler(event){
  if(event.httpMethod!=='POST') return json(405,{error:'Method not allowed'});
  if(!process.env.OPENAI_API_KEY) return json(503,{error:'Live Judge is not configured. Add OPENAI_API_KEY in Vercel Environment Variables and redeploy.'});
  let body={};try{body=JSON.parse(event.body||'{}')}catch{return json(400,{error:'Invalid request'})}
  const question=String(body.question||'').trim().slice(0,5000);if(!question)return json(400,{error:'Ask a rules question first.'});
  const history=(Array.isArray(body.history)?body.history:[]).slice(-8).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:String(x?.content||'').slice(0,2500)})).filter(x=>x.content);

  let cr={url:RULES_HUB,text:''}, excerpts='', sourceWarning='';
  try{cr=await currentComprehensiveRules();excerpts=retrieve(cr.text,question)}catch(e){sourceWarning=e.message}
  let tournament='';
  if(process.env.WIZARDS_MTR_URL){try{tournament=retrieve(await fetchText(process.env.WIZARDS_MTR_URL),question)}catch{}}
  const cards=attachedCards(body);

  const instructions=`You are HexVault Judge, a Magic: The Gathering rules assistant. Your job is to interpret CURRENT official rules, not keyword-match and not guess.
AUTHORITATIVE ORDER: (1) supplied current Wizards Comprehensive Rules excerpts, (2) supplied official tournament-policy excerpts when present, (3) supplied current Oracle text for attached cards. Never invent a rule number or source. Understand natural language, informal card descriptions, paraphrases, spelling mistakes, and terminology in the user's language; do not require the player to quote an official rule or use an exact formula.
WEB RESEARCH: Use web search when it can find a closely related ruling or interaction. Prefer official Wizards pages, Oracle/Gatherer-style rulings, established judge resources, and well-supported community discussions. Community answers are supporting context only and never override official rules or Oracle text. Clearly identify uncertainty or disagreement. Do not copy unsupported forum claims into the ruling.
ANSWERING RULE: A retrieved excerpt is evidence, not a keyword gate. If no excerpt matches the player's wording exactly but the interaction can still be resolved reliably from the rules principles and card text provided, give the useful ruling and be transparent about the basis. Do not fail merely because the question uses different wording. If you cannot verify an exact rule number, omit that number instead of withholding the answer or inventing one.
CONTEXT RULE: First decide whether the player's wording contains enough information. Prefer answering the clear part of the question. Only when a materially different outcome depends on missing game state, ask ONE short clarification instead of assuming. Example: “Who wins, 16–15, I have 16” is ambiguous: life totals alone do not explain why the game ended; ask whether time was called, a game-ending effect occurred, or something else. Never infer that higher life wins when time expires.
TOURNAMENT RULE: The Comprehensive Rules do not by themselves determine all tournament end-of-match procedures. If the question requires tournament policy and no official tournament excerpt was supplied, explain that briefly and ask the needed tournament context rather than fabricating policy.
STYLE: Respond in the user's language (${String(body.language||'en')}). Start useful and simple. No developer/debug wording. No “production endpoint”, “keyword-level answer”, or implementation notes.
Return ONLY JSON with keys: status ("answer" or "clarify"), quick, clarification, explain, judgeDetail, references. clarification is empty for status=answer. references is an array of {label,section,url}; include only sources actually used.`;

  const input=`Return the Judge ruling as one JSON object matching the required schema.\n\nRECENT CONVERSATION:\n${history.length?JSON.stringify(history,null,2):'None'}\n\nPLAYER QUESTION:\n${question}\n\nATTACHED CARD ORACLE TEXT:\n${cards.length?JSON.stringify(cards,null,2):'None'}\n\nCURRENT WIZARDS COMPREHENSIVE RULES — RETRIEVED EXCERPTS:\n${excerpts||'[No relevant excerpt retrieved]'}\n\nOFFICIAL TOURNAMENT POLICY EXCERPTS:\n${tournament||'[Not supplied for this request]'}\n\nSOURCE STATUS:\nComprehensive Rules URL: ${cr.url}\n${sourceWarning?`Warning: ${sourceWarning}`:'Current rules document retrieved from the Wizards rules hub.'}`;
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_JUDGE_MODEL||'gpt-5-mini',instructions,input,tools:[{type:'web_search'}],max_output_tokens:1800})});
    const data=await r.json();if(!r.ok){console.error('HexVault Judge API error',data?.error?.code||r.status);return json(502,{error:'The Judge service could not complete this question. Please try again.'})}
    const rawAnswer=extractOutput(data);
    let out;
    try{out=parseJudgeOutput(rawAnswer)}catch{
      if(!rawAnswer.trim())return json(502,{error:'The rules assistant did not return an answer. Please try again.'});
      out={status:'answer',quick:rawAnswer.trim(),clarification:'',explain:'',judgeDetail:'',references:[]};
    }
    out.status=out.status==='clarify'?'clarify':'answer';out.references=Array.isArray(out.references)?out.references:[];
    for(const source of extractWebCitations(data))if(!out.references.some(x=>x.url===source.url))out.references.push(source);
    if(excerpts && !out.references.some(x=>String(x.url||'').includes('wizards')))out.references.push({label:'Magic Comprehensive Rules',section:'Relevant rules retrieved for this question',url:cr.url});
    return json(200,out);
  }catch{return json(502,{error:'Could not reach the rules assistant. Try again.'})}
}
