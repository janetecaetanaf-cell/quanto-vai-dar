// Guarda o app no celular para abrir mesmo sem internet no mercado.
// Ao publicar uma versão nova, troque o mesmo número em três lugares: APP_CACHE aqui,
// os "?v=" do index.html e o "?v=" do import do ocr.js no app.js.
const APP_CACHE = 'qvd-app-v4';
const CDN_CACHE = 'qvd-cdn-v1';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ocr.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', event => {
  // cache: 'reload' busca no servidor, sem reaproveitar cópia velha do navegador.
  const fresh = APP_FILES.map(f => new Request(f, { cache: 'reload' }));
  event.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== APP_CACHE && k !== CDN_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Arquivos do app: pergunta ao servidor se mudou (no-cache) e cai para a cópia guardada
  // sem internet. Sem isso, o navegador podia juntar página nova com código velho.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(APP_CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'))),
    );
    return;
  }

  // Leitor de etiquetas e fontes: baixa uma vez e reaproveita.
  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(
      caches.open(CDN_CACHE).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }),
    );
  }
});
