const SUPPORT_EMAIL='hexvaultsupport@gmail.com';
const json=(res,status,body)=>res.status(status).json(body);
const clean=(value,max=4000)=>String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').trim().slice(0,max);

export default async function handler(req,res){
  const origin=req.headers.origin;if(origin==='https://localhost'||origin==='capacitor://localhost')res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const token=process.env.RESEND_API_KEY;
  if(!token)return json(res,503,{error:'Bug reporting is not configured yet. Add RESEND_API_KEY in Vercel.'});
  const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
  const report={
    category:clean(body.category,80)||'Bug / something is not working',
    description:clean(body.description,6000)||'No additional explanation provided.',
    contact:clean(body.contact,320),
    page:clean(body.diagnostics?.page,120),version:clean(body.diagnostics?.version,30),
    device:clean(body.diagnostics?.device,800),viewport:clean(body.diagnostics?.viewport,80),
    online:body.diagnostics?.online===false?'No':'Yes',errors:Array.isArray(body.diagnostics?.errors)?body.diagnostics.errors.slice(-8).map(x=>clean(x,800)):[]
  };
  const escape=value=>clean(value,8000).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const html=`<h2>HexVault bug report</h2><p><b>Category:</b> ${escape(report.category)}</p><p><b>User explanation:</b><br>${escape(report.description).replace(/\n/g,'<br>')}</p><hr><p><b>App page:</b> ${escape(report.page||'Unknown')}<br><b>Version:</b> ${escape(report.version||'Unknown')}<br><b>Online:</b> ${report.online}<br><b>Viewport:</b> ${escape(report.viewport||'Unknown')}<br><b>Device/browser:</b> ${escape(report.device||'Unknown')}</p>${report.errors.length?`<p><b>Recent app errors:</b></p><ul>${report.errors.map(e=>`<li><code>${escape(e)}</code></li>`).join('')}</ul>`:'<p><b>Recent app errors:</b> None captured</p>'}<p><b>Optional reply address:</b> ${escape(report.contact||'Not provided')}</p>`;
  const payload={from:process.env.BUG_REPORT_FROM||'HexVault Reports <onboarding@resend.dev>',to:[SUPPORT_EMAIL],subject:`HexVault bug · ${report.category} · ${report.version||'unknown version'}`,html};
  if(report.contact)payload.reply_to=report.contact;
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)return json(res,502,{error:result.message||'The report could not be delivered.'});
  return json(res,200,{ok:true,id:result.id||''});
}
