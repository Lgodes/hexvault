const json=(res,status,body)=>res.status(status).setHeader('Cache-Control','no-store').json(body);
const parseModelJSON=response=>{
  if(typeof response?.output_text==='string'&&response.output_text.trim())return JSON.parse(response.output_text.replace(/^```json\s*|\s*```$/g,''));
  const text=(response?.output||[]).flatMap(item=>item?.content||[]).find(item=>item?.type==='output_text')?.text;
  if(!text)throw new Error('Recognition service returned no result.');
  return JSON.parse(String(text).replace(/^```json\s*|\s*```$/g,''));
};
const languageCode=value=>{
  const v=String(value||'').toLowerCase().trim(),map={
    english:'en',eng:'en',spanish:'es',español:'es',spa:'es',french:'fr',français:'fr',fra:'fr',fre:'fr',german:'de',deutsch:'de',deu:'de',ger:'de',italian:'it',italiano:'it',ita:'it',portuguese:'pt',português:'pt',por:'pt',
    japanese:'ja','日本語':'ja',jp:'ja',jpn:'ja',korean:'ko','한국어':'ko',kr:'ko',kor:'ko',russian:'ru','русский':'ru',rus:'ru',
    'simplified chinese':'zhs','简体中文':'zhs','zh-hans':'zhs','zh-cn':'zhs',zho:'zhs',chi:'zhs',chinese:'zhs',
    'traditional chinese':'zht','繁體中文':'zht','zh-hant':'zht','zh-tw':'zht',
    hebrew:'he','עברית':'he',heb:'he',latin:'la',lat:'la','ancient greek':'grc',greek:'grc',ell:'grc',grc:'grc',arabic:'ar','العربية':'ar',ara:'ar',sanskrit:'sa','संस्कृतम्':'sa',san:'sa',phyrexian:'ph'
  };
  return map[v]||(/^[a-z]{2,3}$/.test(v)?v:'');
};
// Keep letters and numbers from every script. The previous Latin-only
// normalizer turned Japanese/Chinese/Korean/Russian titles into an empty
// string, which could make two unrelated localized titles compare equal.
const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const sameTitle=(left,right)=>{
  const a=normalized(left),b=normalized(right);
  return Boolean(a&&b&&a===b);
};
async function scryfall(path){const response=await fetch('https://api.scryfall.com'+path,{headers:{Accept:'application/json;q=0.9,*/*;q=0.8','User-Agent':'HexVault/164 card recognition'}});if(!response.ok)return null;return response.json()}
async function verify(clue){
  const lang=languageCode(clue.language),set=String(clue.set_code||'').toLowerCase().replace(/[^a-z0-9]/g,''),number=String(clue.collector_number||'').trim().replace(/^#/,''),visibleTitle=String(clue.visible_title||clue.printed_name||'').trim();
  let card=null;
  if(set&&number){card=await scryfall(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}${lang?'/'+encodeURIComponent(lang):''}`);if(!card)card=await scryfall(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`)}
  // Scryfall's multilingual catalog can resolve the title physically printed
  // on a Japanese/Korean/Chinese/Russian card even when the vision model's
  // English-name guess is imperfect.
  if(!card&&visibleTitle){card=await scryfall('/cards/named?exact='+encodeURIComponent(visibleTitle)+(set?'&set='+encodeURIComponent(set):''));}
  if(!card&&visibleTitle&&lang){const safeTitle=visibleTitle.replace(/["\\]/g,' ').trim(),query=[`lang:${lang}`,set?`set:${set}`:'',safeTitle?`!"${safeTitle}"`:''].filter(Boolean).join(' '),localized=await scryfall('/cards/search?include_multilingual=true&unique=prints&order=released&dir=desc&q='+encodeURIComponent(query));if(localized?.data?.[0])card=localized.data[0]}
  if(!card&&clue.canonical_name)card=await scryfall('/cards/named?exact='+encodeURIComponent(clue.canonical_name));
  if(!card&&clue.canonical_name)card=await scryfall('/cards/named?fuzzy='+encodeURIComponent(clue.canonical_name));
  if(card&&lang&&lang!=='en'&&card.lang!==lang&&card.oracle_id){
    const localized=await scryfall('/cards/search?include_multilingual=true&unique=prints&order=released&dir=desc&q='+encodeURIComponent(`oracleid:${card.oracle_id} lang:${lang}`));
    if(localized?.data?.[0])card=localized.data[0];
  }
  // A requested/detected localized printing must remain localized. Returning
  // the English fallback while labelling it Japanese was the other source of
  // convincing but incorrect matches.
  if(card&&lang&&lang!=='en'&&card.lang!==lang)card=null;
  return {card,lang};
}
async function verifiedCandidates(clue){
  const clues=[clue,...(clue.alternatives||[]).map(name=>({...clue,canonical_name:name,set_code:'',collector_number:'',confidence:Math.min(55,Number(clue.confidence)||0)}))],out=[];
  for(const candidate of clues){const result=await verify(candidate);if(result.card&&!out.some(item=>item.card.id===result.card.id))out.push({...result,clue:candidate});}
  return out.sort((a,b)=>Number(sameTitle(clue.visible_title,b.card.printed_name||b.card.name))-Number(sameTitle(clue.visible_title,a.card.printed_name||a.card.name)));
}
export default async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'POST required'});
  if(!process.env.OPENAI_API_KEY)return json(res,503,{error:'Card recognition is not configured. Add OPENAI_API_KEY in Vercel.'});
  const requestedMode=String(req.body?.mode||'single'),mode=requestedMode==='binder-layout'?'binder-layout':requestedMode==='binder'?'binder':'single',images=Array.isArray(req.body?.images)?req.body.images.slice(0,12).map(String):[],image=String(req.body?.image||''),titleImage=String(req.body?.titleImage||''),setCodes=Array.isArray(req.body?.sets)?req.body.sets.slice(0,8):[],language=String(req.body?.language||'auto');
  if(mode==='binder-layout'){
    const binderImage=String(req.body?.binderImage||'');if(!binderImage.startsWith('data:image/')||binderImage.length>2_800_000)return json(res,400,{error:'A compressed full binder-page image is required.'});
    const prompt='Locate every visible Magic: The Gathering card on this binder page. Return normalized card rectangles where x,y,w,h are numbers from 0 to 1 relative to the full image. Detect the real cards rather than assuming a fixed grid. Ignore empty pockets. Order slots left-to-right then top-to-bottom. quality is good, usable, or poor. Set glare true when reflections obscure important card areas.';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),9000);
    try{
      const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_VISION_MODEL||'gpt-4o-mini',input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:binderImage,detail:'high'}]}],text:{format:{type:'json_schema',name:'mtg_binder_layout',strict:true,schema:{type:'object',additionalProperties:false,properties:{quality:{type:'string',enum:['good','usable','poor']},glare:{type:'boolean'},cards:{type:'array',minItems:0,maxItems:12,items:{type:'object',additionalProperties:false,properties:{slot:{type:'integer'},x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'}},required:['slot','x','y','w','h']}}},required:['quality','glare','cards']}}},max_output_tokens:650})});
      const payload=await response.json();if(!response.ok)return json(res,response.status===429?429:502,{error:payload?.error?.message||'Binder page detection failed.',code:payload?.error?.code||payload?.error?.type||'layout_failed'});
      const parsed=parseModelJSON(payload),cards=(parsed.cards||[]).map((box,index)=>({slot:Number(box.slot)||index+1,x:Math.max(0,Math.min(1,Number(box.x)||0)),y:Math.max(0,Math.min(1,Number(box.y)||0)),w:Math.max(.08,Math.min(1,Number(box.w)||0)),h:Math.max(.12,Math.min(1,Number(box.h)||0))})).filter(box=>box.x+box.w>.05&&box.y+box.h>.05&&box.x<.98&&box.y<.98);
      return json(res,200,{quality:parsed.quality||'usable',glare:Boolean(parsed.glare),cards});
    }catch(error){if(error.name==='AbortError')return json(res,504,{error:'Binder page detection timed out.'});return json(res,500,{error:error.message||'Binder page detection failed.'})}finally{clearTimeout(timer)}
  }
  if(mode==='binder'){
    const binderImage=String(req.body?.binderImage||''),validImages=images.filter(value=>value.startsWith('data:image/')&&value.length<=700_000);if(!validImages.length&&(!binderImage.startsWith('data:image/')||binderImage.length>2_800_000))return json(res,400,{error:'Individual binder card crops or a compressed binder-page image are required.'});if(validImages.reduce((sum,value)=>sum+value.length,0)>3_600_000)return json(res,413,{error:'Binder card crops are too large.'});
    const prompt=validImages.length?`The following ${validImages.length} images are individual cards cropped from one binder page, in slot order. Return exactly one record per image using slot 1 through ${validImages.length}. For each card, transcribe the printed title, identify its canonical English name, printed language, set code and collector number. Cards may use any official MTG language. confidence is 0-100. Set recognized=false if the title cannot be read safely; do not invent from artwork alone. ${language!=='auto'?`The expected language is ${language}, but correct it when visibly different.`:''} ${setCodes.length?`Likely sets are ${setCodes.join(', ')}, but do not force them.`:''}`:`Inspect this complete binder page and return one record per visible occupied pocket, ordered left-to-right and top-to-bottom. Identify printed title, canonical English name, language, set and collector number. Never invent from artwork alone.`;
    const content=[{type:'input_text',text:prompt}];if(validImages.length)validImages.forEach((value,index)=>content.push({type:'input_text',text:`Slot ${index+1}`},{type:'input_image',image_url:value,detail:'high'}));else content.push({type:'input_image',image_url:binderImage,detail:'high'});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_VISION_MODEL||'gpt-4o-mini',input:[{role:'user',content}],text:{format:{type:'json_schema',name:'mtg_binder_recognition',strict:true,schema:{type:'object',additionalProperties:false,properties:{cards:{type:'array',minItems:0,maxItems:12,items:{type:'object',additionalProperties:false,properties:{slot:{type:'integer'},recognized:{type:'boolean'},canonical_name:{type:'string'},printed_name:{type:'string'},language:{type:'string'},set_code:{type:'string'},collector_number:{type:'string'},confidence:{type:'integer'}},required:['slot','recognized','canonical_name','printed_name','language','set_code','collector_number','confidence']}}},required:['cards']}}},max_output_tokens:1300})});
      const payload=await response.json();if(!response.ok){const code=payload?.error?.code||payload?.error?.type||'recognition_failed';if(response.status===401)return json(res,401,{error:'The recognition API key was rejected.',code});if(response.status===429)return json(res,429,{error:'Recognition credit or rate limit reached.',code});return json(res,502,{error:payload?.error?.message||'Binder recognition failed.',code})}
      const parsed=parseModelJSON(payload),verified=await Promise.all((parsed.cards||[]).map(async clue=>{
        if(!clue.recognized)return {slot:clue.slot,recognized:false,reason:'empty_or_unreadable'};
        const result=await verify(clue);if(!result.card)return {slot:clue.slot,recognized:false,reason:'not_verified',clue};
        const visible=clue.printed_name||clue.canonical_name,expected=result.card.printed_name||result.card.name,titleMatches=sameTitle(visible,expected)||sameTitle(clue.canonical_name,result.card.name),setVerified=Boolean(clue.set_code&&result.card.set===String(clue.set_code).toLowerCase()),exactPrinting=Boolean(setVerified&&clue.collector_number&&String(result.card.collector_number)===String(clue.collector_number).replace(/^#/,'')),confidence=Math.max(0,Math.min(100,Number(clue.confidence)||0));
        if(!titleMatches||confidence<60)return {slot:clue.slot,recognized:false,reason:'not_verified',clue:{...clue,confidence:Math.min(confidence,55)}};
        const needsReview=!exactPrinting||confidence<80;
        return {slot:clue.slot,recognized:true,needs_review:needsReview,card:result.card,detected:{...clue,confidence:needsReview?Math.min(confidence,79):confidence,title_verified:true,set_verified:setVerified,printing_verified:exactPrinting,language:result.lang||languageCode(clue.language)||result.card.lang||''}};
      }));
      return json(res,200,{cards:verified,verified:true});
    }catch(error){if(error.name==='AbortError')return json(res,504,{error:'Binder recognition took too long. Move closer and keep the full page visible.'});return json(res,500,{error:error.message||'Binder recognition failed.'})}finally{clearTimeout(timer)}
  }
  if(!image.startsWith('data:image/')||image.length>2_800_000||titleImage&&(!titleImage.startsWith('data:image/')||titleImage.length>900_000))return json(res,400,{error:'A compressed card image is required.'});
  const prompt=`Identify the physical Magic: The Gathering card shown. First transcribe only the title visibly printed on the card into visible_title. Then identify its canonical English name. Inspect artwork, frame, mana cost, type line, printed title, set symbol/code and collector number together. The printing may be in any official MTG language, including Japanese, Korean, Simplified/Traditional Chinese and Russian. canonical_name must be the official English card name. language must be an MTG/Scryfall language code. confidence is integer 0-100. alternatives contains up to 3 plausible canonical English names. ${language!=='auto'?`The user expects language ${language}, but correct it if the image clearly differs.`:''} ${setCodes.length?`Likely set codes: ${setCodes.join(', ')}; do not force them if visually wrong.`:''} If a non-Latin printed title is too small or reflective to transcribe perfectly, still return the best canonical English candidate using the visible artwork, frame, mana cost, set symbol and collector number, but lower confidence and include alternatives. Never assign high confidence from artwork alone and never invent an exact printing.`;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6500);
  try{
    const content=[{type:'input_text',text:prompt},{type:'input_image',image_url:image,detail:'high'}];if(titleImage)content.push({type:'input_text',text:'This second image is a sharper crop of the printed title bar from the same physical card.'},{type:'input_image',image_url:titleImage,detail:'high'});const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_VISION_MODEL||'gpt-4o-mini',input:[{role:'user',content}],text:{format:{type:'json_schema',name:'mtg_card_recognition',strict:true,schema:{type:'object',additionalProperties:false,properties:{visible_title:{type:'string'},canonical_name:{type:'string'},printed_name:{type:'string'},language:{type:'string'},set_code:{type:'string'},collector_number:{type:'string'},confidence:{type:'integer'},alternatives:{type:'array',items:{type:'string'},maxItems:3}},required:['visible_title','canonical_name','printed_name','language','set_code','collector_number','confidence','alternatives']}}},max_output_tokens:320})});
    const payload=await response.json();if(!response.ok){const code=payload?.error?.code||payload?.error?.type||'recognition_failed',message=payload?.error?.message||'Card recognition failed.';if(response.status===401)return json(res,401,{error:'The recognition API key was rejected. Replace OPENAI_API_KEY in Vercel and redeploy.',code});if(response.status===429)return json(res,429,{error:['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached'].includes(code)?'The OpenAI project has no available API credit.':'Card recognition is temporarily rate-limited. Try again shortly.',code});if(response.status===404)return json(res,502,{error:'The configured vision model is unavailable to this OpenAI project.',code});return json(res,502,{error:message,code})}
    const clue=parseModelJSON(payload),candidates=await verifiedCandidates(clue),verified=candidates[0];
    if(!verified?.card)return json(res,422,{error:'The card could not be verified in the Magic database.',clue});
    const expectedTitle=verified.card.printed_name||verified.card.name,titleMatches=sameTitle(clue.visible_title,expectedTitle),exactPrinting=Boolean(clue.set_code&&clue.collector_number&&verified.card.set===String(clue.set_code).toLowerCase()&&String(verified.card.collector_number)===String(clue.collector_number).replace(/^#/,''));
    let confidence=Math.max(0,Math.min(100,Number(clue.confidence)||0));if(!titleMatches)confidence=Math.min(confidence,55);else if(!exactPrinting)confidence=Math.min(confidence,79);
    const needsConfirmation=!titleMatches||!exactPrinting,detectedLanguage=verified.lang||languageCode(clue.language)||verified.card.lang||'';
    let printingVariants=[];
    if(needsConfirmation&&verified.card.oracle_id){
      const set=String(clue.set_code||verified.card.set||'').toLowerCase().replace(/[^a-z0-9]/g,''),lang=detectedLanguage||verified.card.lang||'en';
      const query=[`oracleid:${verified.card.oracle_id}`,set?`set:${set}`:'',lang?`lang:${lang}`:''].filter(Boolean).join(' ');
      const result=await scryfall('/cards/search?include_multilingual=true&unique=prints&order=collector&q='+encodeURIComponent(query));
      printingVariants=(result?.data||[]).filter(card=>(!set||card.set===set)&&(!lang||card.lang===lang)).slice(0,24);
    }
    if(!printingVariants.some(card=>card.id===verified.card.id))printingVariants.unshift(verified.card);
    return json(res,200,{card:verified.card,alternatives:candidates.slice(1).map(item=>item.card),printing_variants:printingVariants,detected:{...clue,confidence,title_verified:titleMatches,printing_verified:exactPrinting,language:detectedLanguage},verified:titleMatches,needs_confirmation:needsConfirmation});
  }catch(error){if(error.name==='AbortError')return json(res,504,{error:'Recognition took too long. Try again with the card filling the frame.'});return json(res,500,{error:error.message||'Card recognition failed.'})}finally{clearTimeout(timer)}
}
export {parseModelJSON,languageCode,verify,normalized,sameTitle};
