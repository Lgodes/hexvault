const json=(res,status,body)=>res.status(status).setHeader('Cache-Control','no-store').json(body);
const parseModelJSON=response=>{
  if(typeof response?.output_text==='string'&&response.output_text.trim())return JSON.parse(response.output_text.replace(/^```json\s*|\s*```$/g,''));
  const text=(response?.output||[]).flatMap(item=>item?.content||[]).find(item=>item?.type==='output_text')?.text;
  if(!text)throw new Error('Recognition service returned no result.');
  return JSON.parse(String(text).replace(/^```json\s*|\s*```$/g,''));
};
const languageCode=value=>{
  const v=String(value||'').toLowerCase().trim(),map={english:'en',spanish:'es',french:'fr',german:'de',italian:'it',portuguese:'pt',japanese:'ja',korean:'ko',russian:'ru','simplified chinese':'zhs','traditional chinese':'zht',hebrew:'he',arabic:'ar',latin:'la',phyrexian:'ph'};
  return map[v]||(/^[a-z]{2,3}$/.test(v)?v:'');
};
async function scryfall(path){const response=await fetch('https://api.scryfall.com'+path,{headers:{Accept:'application/json','User-Agent':'HexVault/144 card recognition'}});if(!response.ok)return null;return response.json()}
async function verify(clue){
  const lang=languageCode(clue.language),set=String(clue.set_code||'').toLowerCase().replace(/[^a-z0-9]/g,''),number=String(clue.collector_number||'').trim().replace(/^#/,'');
  let card=null;
  if(set&&number){card=await scryfall(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}${lang?'/'+encodeURIComponent(lang):''}`);if(!card)card=await scryfall(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`)}
  if(!card&&clue.canonical_name)card=await scryfall('/cards/named?exact='+encodeURIComponent(clue.canonical_name));
  if(!card&&clue.canonical_name)card=await scryfall('/cards/named?fuzzy='+encodeURIComponent(clue.canonical_name));
  if(card&&lang&&lang!=='en'&&card.lang!==lang&&card.oracle_id){
    const localized=await scryfall('/cards/search?include_multilingual=true&unique=prints&order=released&dir=desc&q='+encodeURIComponent(`oracleid:${card.oracle_id} lang:${lang}`));
    if(localized?.data?.[0])card=localized.data[0];
  }
  return {card,lang};
}
export default async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'POST required'});
  if(!process.env.OPENAI_API_KEY)return json(res,503,{error:'Card recognition is not configured. Add OPENAI_API_KEY in Vercel.'});
  const image=String(req.body?.image||''),setCodes=Array.isArray(req.body?.sets)?req.body.sets.slice(0,8):[],language=String(req.body?.language||'auto');
  if(!image.startsWith('data:image/')||image.length>2_800_000)return json(res,400,{error:'A compressed card image is required.'});
  const prompt=`Identify the physical Magic: The Gathering card shown. Read the whole card visually, including artwork, printed title, set symbol/code and collector number. The printing may be in any official MTG language. Return JSON only with keys canonical_name, printed_name, language, set_code, collector_number, confidence, alternatives. canonical_name must be the official English card name. language should be an MTG/Scryfall language code. confidence is integer 0-100. alternatives is up to 3 canonical English names. ${language!=='auto'?`The user expects language ${language}, but correct it if the image clearly differs.`:''} ${setCodes.length?`Likely set codes: ${setCodes.join(', ')}; do not force them if visually wrong.`:''} If uncertain, lower confidence rather than inventing a card.`;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6500);
  try{
    const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_VISION_MODEL||'gpt-4o-mini',input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:image,detail:'low'}]}],text:{format:{type:'json_schema',name:'mtg_card_recognition',strict:true,schema:{type:'object',additionalProperties:false,properties:{canonical_name:{type:'string'},printed_name:{type:'string'},language:{type:'string'},set_code:{type:'string'},collector_number:{type:'string'},confidence:{type:'integer'},alternatives:{type:'array',items:{type:'string'},maxItems:3}},required:['canonical_name','printed_name','language','set_code','collector_number','confidence','alternatives']}}},max_output_tokens:260})});
    const payload=await response.json();if(!response.ok){const code=payload?.error?.code||payload?.error?.type||'recognition_failed';return json(res,response.status===429?429:502,{error:payload?.error?.message||'Card recognition failed.',code})}
    const clue=parseModelJSON(payload),verified=await verify(clue);
    if(!verified.card)return json(res,422,{error:'The card could not be verified in the Magic database.',clue});
    return json(res,200,{card:verified.card,detected:{...clue,language:verified.lang||languageCode(clue.language)||verified.card.lang||''},verified:true});
  }catch(error){if(error.name==='AbortError')return json(res,504,{error:'Recognition took too long. Try again with the card filling the frame.'});return json(res,500,{error:error.message||'Card recognition failed.'})}finally{clearTimeout(timer)}
}
export {parseModelJSON,languageCode,verify};
