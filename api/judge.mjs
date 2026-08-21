import { handler as netlifyHandler } from '../server/judge-core.mjs';
export default async function handler(req,res){
  const origin=req.headers.origin;if(origin==='https://localhost'||origin==='capacitor://localhost')res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');if(req.method==='OPTIONS')return res.status(204).end();
  let body=req.body; if(typeof body!=='string') body=JSON.stringify(body||{});
  const out=await netlifyHandler({httpMethod:req.method,body,headers:req.headers});
  res.status(out.statusCode||200); for(const [k,v] of Object.entries(out.headers||{}))res.setHeader(k,v); return res.send(out.body||'');
}
