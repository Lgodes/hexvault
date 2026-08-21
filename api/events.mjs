import { handler as netlifyHandler } from '../server/events-core.mjs';
export default async function handler(req,res){
  const origin=req.headers.origin;if(origin==='https://localhost'||origin==='capacitor://localhost')res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');if(req.method==='OPTIONS')return res.status(204).end();
  const u=new URL(req.url,`https://${req.headers.host||'localhost'}`);
  const q=Object.fromEntries(u.searchParams.entries());
  const multi={}; for(const [k,v] of u.searchParams){(multi[k]??=[]).push(v)}
  const out=await netlifyHandler({httpMethod:req.method,queryStringParameters:q,multiValueQueryStringParameters:multi,headers:req.headers});
  res.status(out.statusCode||200); for(const [k,v] of Object.entries(out.headers||{}))res.setHeader(k,v); if((out.statusCode||200)===204)return res.end(); return res.send(out.body||'');
}
