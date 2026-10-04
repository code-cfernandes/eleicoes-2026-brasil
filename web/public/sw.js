// Service worker: notificações push e a tela abrindo mesmo sem rede (os dados exigem conexão).
// Fica fora do bundle do Vite de propósito: precisa estar em /sw.js para controlar o site inteiro.
const CACHE = 'apuracao-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icones/icone-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Dados da apuração sempre da rede: o backend já cuida de cache/304
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (e.request.mode === 'navigate') {
    // Página: rede primeiro; sem rede, a última versão guardada
    e.respondWith(fetch(e.request)
      .then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put('/', copia)); return r; })
      .catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icones/')) {
    // Arquivos com hash no nome nunca mudam: cache primeiro
    e.respondWith(caches.match(e.request).then((guardado) => guardado || fetch(e.request).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
      return r;
    })));
  }
});

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { titulo: 'Apuração 2026', corpo: 'Há novidades na apuração.', url: '/' };
  e.waitUntil(self.registration.showNotification(d.titulo, {
    body: d.corpo,
    tag: d.tag,                 // o aviso novo de uma disputa substitui o anterior
    renotify: Boolean(d.tag),   // ...mas ainda vibra/toca
    icon: '/icones/icone-192.png',
    badge: '/icones/badge-96.png',
    lang: 'pt-BR',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil((async () => {
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const aba = abas.find((c) => new URL(c.url).origin === location.origin);
    if (aba) {
      await aba.focus();
      try { return await aba.navigate(url); } catch { /* aba não controlada: abre outra */ }
    }
    return self.clients.openWindow(url);
  })());
});

// O navegador trocou a inscrição (expirou/rotacionou): inscreve de novo e avisa o servidor,
// que transfere as disputas seguidas para a inscrição nova.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const antiga = e.oldSubscription;
    const nova = e.newSubscription ?? await self.registration.pushManager.subscribe(antiga.options);
    await fetch('/api/notificacoes/renovar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ antigo: antiga?.endpoint, inscricao: nova.toJSON() }),
    });
  })());
});
