const RULES_HUB = 'https://magic.wizards.com/en/rules';
const MAX_SOURCE = 900000;
const RULES_TTL = 12*60*60*1000;
let rulesCache={savedAt:0,value:null};

function json(statusCode, body){return {statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},body:JSON.stringify(body)}}
function extractOutput(data){
  if(typeof data?.output_text==='string')return data.output_text;
  const parts=[];
  for(const item of data?.output||[])for(const c of item?.content||[]){
    if(typeof c?.text==='string')parts.push(c.text);
    else if(typeof c?.text?.value==='string')parts.push(c.text.value);
    else if(c?.json&&typeof c.json==='object')parts.push(JSON.stringify(c.json));
  }
  return parts.join('\n').trim();
}
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
function normalizeJudgeOutput(value={}){
  const out=value&&typeof value==='object'?value:{};
  const text=v=>typeof v==='string'?v.trim():'';
  const quick=text(out.quick)||text(out.quick_answer)||text(out.answer)||text(out.ruling)||text(out.summary);
  const explain=text(out.explain)||text(out.explanation)||text(out.reasoning)||text(out.details);
  const judgeDetail=text(out.judgeDetail)||text(out.judge_detail)||text(out.technical_detail)||text(out.technical);
  const clarification=text(out.clarification)||text(out.clarifying_question);
  return {status:(out.status==='clarify'||(!quick&&clarification))?'clarify':'answer',quick,clarification,explain,judgeDetail,references:Array.isArray(out.references)?out.references:[]};
}
function decodeHtml(s=''){return s.replace(/&amp;/g,'&').replace(/&#x2F;/gi,'/').replace(/&quot;/g,'"').replace(/&#39;/g,"'")}
async function fetchText(url,timeoutMs=4500){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{const r=await fetch(url,{signal:controller.signal,headers:{'user-agent':'HexVaultRules/2.1 (+rules assistant)'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return (await r.text()).slice(0,MAX_SOURCE)}finally{clearTimeout(timer)}}
async function currentComprehensiveRules(){
  if(rulesCache.value&&Date.now()-rulesCache.savedAt<RULES_TTL)return rulesCache.value;
  const html=await fetchText(RULES_HUB);
  const links=[...html.matchAll(/href=["']([^"']+)["'][^>]*>(?:\s*<[^>]+>)*\s*TXT\s*/gi)].map(m=>decodeHtml(m[1]));
  let url=links[0];
  if(!url){const candidates=[...html.matchAll(/https?:\/\/media\.wizards\.com\/[^"'<>\s]+/gi)].map(m=>decodeHtml(m[0]));url=candidates.find(x=>/MagicCompRules|\.txt(?:\?|$)/i.test(x));}
  if(!url) throw new Error('Current Comprehensive Rules TXT link not found on Wizards rules hub');
  if(url.startsWith('/')) url=new URL(url,RULES_HUB).href;
  const value={url,text:await fetchText(url,6500)};rulesCache={savedAt:Date.now(),value};return value;
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
  return picked.join('\n\n--- relevant rules excerpt ---\n\n').slice(0,12000);
}
function attachedCards(body){const cards=Array.isArray(body.cards)?body.cards:[];return cards.slice(0,12).map(c=>({name:String(c.name||'').slice(0,120),oracle_text:String(c.oracle_text||c.oracle||c.text||'').slice(0,1800),type_line:String(c.type_line||c.type||'').slice(0,300)})).filter(c=>c.name||c.oracle_text)}
function needsWebResearch(question='',cards=[]){return cards.length>=2||question.length>180||/\b(current|latest|recent|today|tournament|policy|mtr|ipg|penalty|infraction|official ruling|judge ruling|web|online|source|citation|interaction|interact|combo|simultaneously|replacement|layer|timestamp|loop|copy)\b/i.test(question)}

export async function handler(event){
  if(event.httpMethod!=='POST') return json(405,{error:'Method not allowed'});
  if(!process.env.OPENAI_API_KEY) return json(503,{error:'Live Judge is not configured. Add OPENAI_API_KEY in Vercel Environment Variables and redeploy.'});
  let body={};try{body=JSON.parse(event.body||'{}')}catch{return json(400,{error:'Invalid request'})}
  const question=String(body.question||'').trim().slice(0,5000);if(!question)return json(400,{error:'Ask a rules question first.'});
  const history=(Array.isArray(body.history)?body.history:[]).slice(-8).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:String(x?.content||'').slice(0,2500)})).filter(x=>x.content);

  const cards=attachedCards(body),useResearch=body.research===true||needsWebResearch(question,cards);
  let cr={url:RULES_HUB,text:''}, excerpts='', sourceWarning='Fast answer mode — live source retrieval was not required.';
  if(useResearch)try{cr=await currentComprehensiveRules();excerpts=retrieve(cr.text,question);sourceWarning=''}catch(e){sourceWarning=e.message}
  let tournament='';
  if(useResearch&&process.env.WIZARDS_MTR_URL){try{tournament=retrieve(await fetchText(process.env.WIZARDS_MTR_URL),question)}catch{}}

  const instructions=`You are HexVault Judge, a Magic: The Gathering rules assistant. Your job is to interpret CURRENT official rules, not keyword-match and not guess.
AUTHORITATIVE ORDER: (1) supplied current Wizards Comprehensive Rules excerpts, (2) supplied official tournament-policy excerpts when present, (3) supplied current Oracle text for attached cards. Never invent a rule number or source. Understand natural language, informal card descriptions, paraphrases, spelling mistakes, and terminology in the user's language; do not require the player to quote an official rule or use an exact formula.
WEB RESEARCH: Use web search when it can find a closely related ruling or interaction. Prefer official Wizards pages, Oracle/Gatherer-style rulings, established judge resources, and well-supported community discussions. Community answers are supporting context only and never override official rules or Oracle text. Clearly identify uncertainty or disagreement. Do not copy unsupported forum claims into the ruling.
ANSWERING RULE: A retrieved excerpt is evidence, not a keyword gate. If no excerpt matches the player's wording exactly but the interaction can still be resolved reliably from the rules principles and card text provided, give the useful ruling and be transparent about the basis. Do not fail merely because the question uses different wording. If you cannot verify an exact rule number, omit that number instead of withholding the answer or inventing one.
INTERPRETATION RULE: Many real table questions are not written verbatim in the rulebook. Derive the outcome by combining the applicable game concepts, sequence of events, current Oracle text, state-based actions, replacement/trigger rules, and known official rulings. When that derivation is reliable, answer it clearly and say in the explanation that the conclusion follows from those principles rather than from one verbatim rule. When web research finds a closely analogous judge/community answer, use it only as corroboration and label it as supporting context. Never manufacture a card ability, game fact, rule number, or citation.
USEFULNESS RULE: Do not respond with only a link to the Comprehensive Rules. quick must contain the actual table-ready result. explain must describe why. judgeDetail may show the stack/order, applicable principles, and any important exception. If the available facts support more than one outcome, describe the branches briefly or ask the one missing detail that decides between them.
CONTEXT RULE: First decide whether the player's wording contains enough information. Prefer answering the clear part of the question. Only when a materially different outcome depends on missing game state, ask ONE short clarification instead of assuming. Example: “Who wins, 16–15, I have 16” is ambiguous: life totals alone do not explain why the game ended; ask whether time was called, a game-ending effect occurred, or something else. Never infer that higher life wins when time expires.
TOURNAMENT RULE: The Comprehensive Rules do not by themselves determine all tournament end-of-match procedures. If the question requires tournament policy and no official tournament excerpt was supplied, explain that briefly and ask the needed tournament context rather than fabricating policy.
STYLE: ${String(body.language||'auto')==='auto'?'Detect the language of the newest PLAYER QUESTION and answer in that same language. Do not use the browser, device, earlier conversation, card printing, or attached-card language to choose the answer language. An English newest question must receive an English answer; a Spanish newest question must receive a Spanish answer.':'Respond in the explicitly requested language ('+String(body.language)+').' } Start useful and simple. No developer/debug wording. No “production endpoint”, “keyword-level answer”, or implementation notes.
Return ONLY JSON with keys: status ("answer" or "clarify"), quick, clarification, explain, judgeDetail, references. clarification is empty for status=answer. references is an array of {label,section,url}; include only sources actually used.`;

  const input=`Return the Judge ruling as one JSON object matching the required schema.\n\nRECENT CONVERSATION:\n${history.length?JSON.stringify(history,null,2):'None'}\n\nPLAYER QUESTION:\n${question}\n\nATTACHED CARD ORACLE TEXT:\n${cards.length?JSON.stringify(cards,null,2):'None'}\n\nCURRENT WIZARDS COMPREHENSIVE RULES — RETRIEVED EXCERPTS:\n${excerpts||'[No relevant excerpt retrieved]'}\n\nOFFICIAL TOURNAMENT POLICY EXCERPTS:\n${tournament||'[Not supplied for this request]'}\n\nSOURCE STATUS:\nComprehensive Rules URL: ${cr.url}\n${sourceWarning?`Warning: ${sourceWarning}`:'Current rules document retrieved from the Wizards rules hub.'}`;
  try{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),22000);
    const payload={model:process.env.OPENAI_JUDGE_MODEL||'gpt-5-mini',instructions,input,max_output_tokens:1200,reasoning:{effort:'low'},text:{format:{type:'json_schema',name:'judge_ruling',strict:true,schema:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['answer','clarify']},quick:{type:'string'},clarification:{type:'string'},explain:{type:'string'},judgeDetail:{type:'string'},references:{type:'array',items:{type:'object',additionalProperties:false,properties:{label:{type:'string'},section:{type:'string'},url:{type:'string'}},required:['label','section','url']}}},required:['status','quick','clarification','explain','judgeDetail','references']}}}};
    if(useResearch)payload.tools=[{type:'web_search'}];
    let r;try{r=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'content-type':'application/json'},body:JSON.stringify(payload)})}finally{clearTimeout(timer)}
    const data=await r.json();if(!r.ok){
      const code=data?.error?.code||data?.error?.type||String(r.status);console.error('HexVault Judge API error',code);
      if(['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached'].includes(code))return json(503,{error:'The Judge API account has no available credit. Add API credit in OpenAI billing, then try again.'});
      if(r.status===401)return json(503,{error:'The Judge API key was rejected. Replace OPENAI_API_KEY in Vercel and redeploy.'});
      if(r.status===429)return json(503,{error:'The Judge is temporarily rate-limited. Wait a moment and try again.'});
      return json(502,{error:`OpenAI rejected this Judge request (${code}). Please try again.`});
    }
    const rawAnswer=extractOutput(data);
    let out;
    try{out=parseJudgeOutput(rawAnswer)}catch{
      if(!rawAnswer.trim())return json(502,{error:'The rules assistant did not return an answer. Please try again.'});
      out={status:'answer',quick:rawAnswer.trim(),clarification:'',explain:'',judgeDetail:'',references:[]};
    }
    out=normalizeJudgeOutput(out);
    if(out.status==='answer'&&!out.quick)return json(502,{error:'The Judge returned sources but no readable ruling. Please ask again.'});
    for(const source of extractWebCitations(data))if(!out.references.some(x=>x.url===source.url))out.references.push(source);
    if(excerpts && !out.references.some(x=>String(x.url||'').includes('wizards')))out.references.push({label:'Magic Comprehensive Rules',section:'Relevant rules retrieved for this question',url:cr.url});
    return json(200,{...out,researchUsed:useResearch});
  }catch(error){if(error?.name==='AbortError')return json(504,{error:'The Judge took too long to answer. Please try once more.'});return json(502,{error:'Could not reach the rules assistant. Try again.'})}
}
export {extractOutput,parseJudgeOutput,normalizeJudgeOutput};
