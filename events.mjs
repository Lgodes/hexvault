import { handler as netlifyHandler } from '../server/events-core.mjs';
export default async function handler(req,res){
  const u=new URL(req.url,`https://${req.headers.host||'localhost'}`);
  const q=Object.fromEntries(u.searchParams.entries());
  const multi={}; for(const [k,v] of u.searchParams){(multi[k]??=[]).push(v)}
  const out=await netlifyHandler({httpMethod:req.method,queryStringParameters:q,multiValueQueryStringParameters:multi,headers:req.headers});
  res.status(out.statusCode||200); for(const [k,v] of Object.entries(out.headers||{}))res.setHeader(k,v); if((out.statusCode||200)===204)return res.end(); return res.send(out.body||'');
}
