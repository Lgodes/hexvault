import { handler as netlifyHandler } from '../server/judge-core.mjs';
export default async function handler(req,res){
  let body=req.body; if(typeof body!=='string') body=JSON.stringify(body||{});
  const out=await netlifyHandler({httpMethod:req.method,body,headers:req.headers});
  res.status(out.statusCode||200); for(const [k,v] of Object.entries(out.headers||{}))res.setHeader(k,v); return res.send(out.body||'');
}
