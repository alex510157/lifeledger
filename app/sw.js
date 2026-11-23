/* LifeLedger 隨手記：手機「加入主畫面」用的 service worker
 * 只快取這個資料夾自己的畫面檔（HTML、JS、圖示），讓 App 打開比較快、沒網路時至少看得到畫面。
 * 永遠先拿網路上最新的；連不上才用快取。
 * 不碰帳本資料：伺服器（/api/…、別的網域）、非 GET 的請求都直接放行，不會被存起來。 */
const CACHE = 'll-shell-v2';
const SHELL = ['./', 'index.html', 'view.html', 'sync.js', 'palette.js', 'qr.js', 'catalog.json', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (req.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(url.pathname === scope.pathname ? './' : req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(r => r || caches.match('./')))
  );
});
