// Service Worker do app de alerta de restricao ONS.
//
// Objetivos:
//   1. cache dos estaticos para funcionar offline;
//   2. Periodic Background Sync para verificar a API de tempos em tempos
//      (quando o navegador suportar); nos demais, o proprio app.js aciona
//      a checagem enquanto estiver em primeiro plano;
//   3. exibir notificacao local quando o corte ultrapassar o limite.

const VERSAO = "v1";
const CACHE = `restricao-ons-${VERSAO}`;
const ESTATICOS = [
  "/app/",
  "/app/index.html",
  "/app/app.css",
  "/app/app.js",
  "/app/manifest.json",
  "/app/icone-192.png",
  "/app/icone-512.png",
  "/data/usinas.json",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ESTATICOS).catch(() => null))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // API sempre da rede
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request).catch(() => r))
  );
});

async function verificar() {
  try {
    const configResp = await fetch("/app/config.json").catch(() => null);
    const config = configResp && configResp.ok ? await configResp.json() : null;
    const clientes = await self.clients.matchAll({ includeUncontrolled: true });
    if (clientes[0]) {
      clientes[0].postMessage({ tipo: "verificar" });
      return;
    }
    if (!config) return;
    const params = new URLSearchParams({ fonte: config.fonte || "eolica" });
    if (config.recorte) params.set("usina", config.recorte);
    const r = await fetch(`/api/restricao?${params}`);
    if (!r.ok) return;
    const dados = await r.json();
    const monit = dados.monitoradas || [];
    const soma = monit.reduce((s, u) => s + (u.corte_mwh || 0), 0);
    if (soma >= (config.limite || 100)) {
      self.registration.showNotification("Restrição alta detectada", {
        body: `${config.rotulo || "Complexo"}: ${soma.toFixed(1)} MWh de corte no dia ${dados.data}`,
        icon: "/app/icone-192.png",
        badge: "/app/icone-192.png",
        tag: `restricao-${dados.data}`,
      });
    }
  } catch (e) {
    // silencioso
  }
}

self.addEventListener("periodicsync", (e) => {
  if (e.tag === "verificar-restricao") e.waitUntil(verificar());
});

self.addEventListener("sync", (e) => {
  if (e.tag === "verificar-restricao") e.waitUntil(verificar());
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.tipo === "notificar") {
    self.registration.showNotification(e.data.titulo || "Restrição ONS", {
      body: e.data.corpo || "",
      icon: "/app/icone-192.png",
      badge: "/app/icone-192.png",
      tag: e.data.tag || "restricao",
    });
  }
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((janelas) => {
      const j = janelas.find((w) => w.url.includes("/app"));
      if (j) return j.focus();
      return self.clients.openWindow("/app/");
    })
  );
});
