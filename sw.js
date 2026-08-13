const VERSION='hexvault-v143';
const STATIC=[
  '/', '/index.html', '/manifest.webmanifest',
  '/logo4.png','/logo4-hd-transparent.png','/coin-epic.png','/d20-epic.png',
  '/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-512.png','/icons/apple-touch-icon.png'
];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(STATIC)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==location.origin) return;
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(res=>{
      const copy=res.clone(); caches.open(VERSION).then(c=>c.put('/index.html',copy)); return res;
    }).catch(()=>caches.match('/index.html')));
    return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(res=>{
    if(res && res.ok){const copy=res.clone(); caches.open(VERSION).then(c=>c.put(req,copy));}
    return res;
  })));
});
