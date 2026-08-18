// PWA de alerta de restricao ONS.
//
// Fluxo:
//   - carrega catalogo de complexos e popula o seletor;
//   - busca /api/restricao e /api/serie para o complexo escolhido;
//   - mantem um timer em primeiro plano; se o usuario ativar as notificacoes,
//     o Service Worker tambem faz verificacoes em background quando o
//     navegador oferecer Periodic Background Sync;
//   - dispara notificacao local (Notifications API) quando o corte diario
//     do complexo passar do limite configurado.

const $ = (id) => document.getElementById(id);
const fmt = (n, c = 1) =>
  (n ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });

const ARMAZEM = "restricao-ons-config";
const CHAVE_ULT = "restricao-ons-ultimo-alerta";

let catalogo = { complexos: [], estados: {} };
let mapa;
let camadaMarcadores;
let timer = null;

function estado() {
  try {
    return JSON.parse(localStorage.getItem(ARMAZEM) || "{}");
  } catch {
    return {};
  }
}

function salvar(c) {
  localStorage.setItem(ARMAZEM, JSON.stringify(c));
}

async function iniciar() {
  await registrarSW();
  catalogo = await carregarCatalogo();
  popularComplexos();
  ligarEventos();
  restaurar();
  await carregar();
  agendarTimer();
  botaoInstalar();
}

async function registrarSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
  } catch (e) {
    console.warn("SW nao registrado", e);
  }
}

async function carregarCatalogo() {
  try {
    const r = await fetch("/data/usinas.json");
    return await r.json();
  } catch (e) {
    return { complexos: [], estados: {} };
  }
}

function popularComplexos() {
  const fonte = $("fonte").value;
  const sel = $("complexo");
  sel.innerHTML = '<option value="">— Todos os complexos —</option>';
  const filtrados = catalogo.complexos.filter((c) => !c.fonte || c.fonte === fonte);
  filtrados
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .forEach((c) => {
      const o = document.createElement("option");
      o.value = c.chave;
      o.dataset.rotulo = c.nome;
      o.textContent = c.nome + (c.uf ? ` (${c.uf})` : "");
      sel.appendChild(o);
    });
}

function ligarEventos() {
  document.querySelectorAll(".aba").forEach((b) => {
    b.addEventListener("click", () => trocarAba(b.dataset.aba));
  });
  $("fonte").addEventListener("change", () => {
    popularComplexos();
    persistir();
    carregar();
  });
  $("complexo").addEventListener("change", () => {
    persistir();
    carregar();
  });
  $("limite").addEventListener("change", persistir);
  $("frequencia").addEventListener("change", () => {
    persistir();
    agendarTimer();
  });
  $("btn-notificar").addEventListener("click", ativarNotificacoes);
  $("btn-testar").addEventListener("click", () => {
    notificar("Teste de alerta", "Se você está vendo isto, as notificações estão funcionando.");
  });
}

function restaurar() {
  const c = estado();
  if (c.fonte) $("fonte").value = c.fonte;
  popularComplexos();
  if (c.complexo) $("complexo").value = c.complexo;
  if (c.limite) $("limite").value = c.limite;
  if (c.frequencia) $("frequencia").value = c.frequencia;
  atualizarEstadoNotif();
}

function persistir() {
  const sel = $("complexo").selectedOptions[0];
  salvar({
    fonte: $("fonte").value,
    complexo: $("complexo").value,
    rotulo: sel ? sel.dataset.rotulo || sel.textContent : null,
    limite: Number($("limite").value) || 100,
    frequencia: Number($("frequencia").value) || 60,
  });
}

function trocarAba(nome) {
  document.querySelectorAll(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === nome));
  document.querySelectorAll(".conteudo").forEach((c) => c.classList.toggle("ativa", c.id === `aba-${nome}`));
  if (nome === "mapa" && mapa) setTimeout(() => mapa.invalidateSize(), 200);
}

async function carregar() {
  const fonte = $("fonte").value;
  const chave = $("complexo").value;
  const rotulo = $("complexo").selectedOptions[0]?.textContent || "SIN inteiro";
  $("rodape-info").textContent = "Buscando dados do ONS…";
  try {
    const params = new URLSearchParams({ fonte });
    if (chave) params.set("usina", chave);
    const [apResp, sResp] = await Promise.all([
      fetch(`/api/restricao?${params}`),
      fetch(`/api/serie?${params}`),
    ]);
    if (!apResp.ok) throw new Error(`HTTP ${apResp.status}`);
    const ap = await apResp.json();
    const serie = sResp.ok ? await sResp.json() : { pontos: [] };
    renderizar(ap, serie, rotulo);
    verificarLimite(ap, rotulo);
    $("rodape-info").textContent = `Dados de ${ap.data} • Atualizado ${new Date().toLocaleTimeString("pt-BR")}`;
  } catch (e) {
    $("rodape-info").textContent = "Falha ao carregar: " + (e.message || e);
  }
}

function somaMonitoradas(ap) {
  const monit = ap.monitoradas || [];
  if (!monit.length) return ap.total?.corte_mwh || 0;
  return monit.reduce((s, u) => s + (u.corte_mwh || 0), 0);
}

function renderizar(ap, serie, rotulo) {
  const cortDia = somaMonitoradas(ap);
  const monit = ap.monitoradas || [];
  const perda =
    monit.length && monit.reduce((s, u) => s + (u.referencia_mwh || 0), 0) > 0
      ? (cortDia / monit.reduce((s, u) => s + u.referencia_mwh, 0)) * 100
      : ap.total?.perda_pct || 0;

  $("corte-total").textContent = fmt(cortDia, 1);
  $("perda-pct").textContent = fmt(perda, 2);

  const pontos = serie.pontos || [];
  const picoCorte = pontos.reduce((m, p) => Math.max(m, p.corte_mw || 0), 0);
  const geracaoAtual = pontos.length ? pontos[pontos.length - 1].geracao_mw : 0;
  $("pico-corte").textContent = fmt(picoCorte, 1);
  $("geracao-agora").textContent = fmt(geracaoAtual, 1);
  $("data-recorte").textContent = `${ap.data} • ${rotulo}`;

  renderizarGrafico(pontos);
  renderizarTop(ap);
  renderizarMapa(ap);
}

function renderizarTop(ap) {
  const ol = $("top");
  ol.innerHTML = "";
  const lista = (ap.monitoradas?.filter((u) => u.corte_mwh > 0).length ? ap.monitoradas : ap.top || [])
    .filter((u) => u.corte_mwh > 0)
    .slice(0, 10);
  if (!lista.length) {
    ol.innerHTML = "<li><span class='nome'>Sem restrições relevantes.</span><span></span></li>";
    return;
  }
  lista.forEach((u) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div class="nome">${u.usina}</div>
        <div class="meta">${u.estado || "-"} • ${fmt(u.perda_pct, 1)}%</div>
      </div>
      <div class="valor">${fmt(u.corte_mwh, 1)} MWh</div>
    `;
    ol.appendChild(li);
  });
}

function localizar(usina) {
  const nome = (usina.usina || "").toUpperCase();
  for (const c of catalogo.complexos) {
    if (nome.includes(c.chave)) return { lat: c.lat, lng: c.lng };
  }
  const e = catalogo.estados[(usina.estado || "").toUpperCase()];
  if (e) return { lat: e.lat + (Math.random() - 0.5) * 0.6, lng: e.lng + (Math.random() - 0.5) * 0.6 };
  return null;
}

function renderizarMapa(ap) {
  if (!mapa) {
    mapa = L.map("mapa").setView([-14.5, -47.5], 4);
    const esri = "https://server.arcgisonline.com/ArcGIS/rest/services";
    L.tileLayer(`${esri}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
      attribution: "Imagens &copy; Esri, Maxar, Earthstar Geographics",
      maxZoom: 19,
      maxNativeZoom: 18,
    }).addTo(mapa);
    L.tileLayer(`${esri}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19,
      maxNativeZoom: 18,
    }).addTo(mapa);
    camadaMarcadores = L.layerGroup().addTo(mapa);
  }
  camadaMarcadores.clearLayers();
  const lista = [...(ap.monitoradas || []), ...(ap.top || [])].filter((u) => u.corte_mwh > 0);
  if (!lista.length) return;
  const max = Math.max(...lista.map((u) => u.corte_mwh));
  const cor = ap.fonte === "fotovoltaica" ? "#facc15" : "#38bdf8";
  const bounds = [];
  const vistas = new Set();
  lista.forEach((u) => {
    if (vistas.has(u.usina)) return;
    vistas.add(u.usina);
    const loc = localizar(u);
    if (!loc) return;
    const raio = 6 + (20 * u.corte_mwh) / max;
    const icone = L.divIcon({
      className: "",
      html: `<div class="pin" style="width:${raio * 2}px;height:${raio * 2}px;background:${cor};"></div>`,
      iconSize: [raio * 2, raio * 2],
    });
    L.marker([loc.lat, loc.lng], { icon: icone })
      .bindPopup(`<strong>${u.usina}</strong><br>${fmt(u.corte_mwh, 1)} MWh (${fmt(u.perda_pct, 1)}%)`)
      .addTo(camadaMarcadores);
    bounds.push([loc.lat, loc.lng]);
  });
  if (bounds.length) mapa.fitBounds(bounds, { padding: [20, 20], maxZoom: 7 });
}

function renderizarGrafico(pontos) {
  const canvas = $("grafico");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);

  if (!pontos.length) {
    ctx.fillStyle = "#92a2c9";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Sem série disponível.", w / 2, h / 2);
    return;
  }

  const padE = 40, padS = 22, padT = 12, padD = 10;
  const areaW = w - padE - padD, areaH = h - padT - padS;
  const maxV = Math.max(1, ...pontos.map((p) => Math.max(p.geracao_mw, p.referencia_mw, p.corte_mw)));
  const x = (i) => padE + (i * areaW) / Math.max(1, pontos.length - 1);
  const y = (v) => padT + areaH - (v / maxV) * areaH;

  ctx.strokeStyle = "#263353";
  ctx.fillStyle = "#92a2c9";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 3; i++) {
    const v = (maxV * i) / 3;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padE, yy);
    ctx.lineTo(w - padD, yy);
    ctx.stroke();
    ctx.fillText(fmt(v, 0), padE - 4, yy + 3);
  }
  ctx.textAlign = "center";
  pontos.forEach((p, i) => {
    if (i % 12 !== 0) return;
    ctx.fillText((p.instante || "").slice(11, 16), x(i), h - padS + 14);
  });

  const linha = (ch, cor, preenche) => {
    ctx.beginPath();
    pontos.forEach((p, i) => {
      const px = x(i), py = y(p[ch] || 0);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (preenche) {
      ctx.lineTo(x(pontos.length - 1), padT + areaH);
      ctx.lineTo(x(0), padT + areaH);
      ctx.closePath();
      ctx.fillStyle = cor + "33";
      ctx.fill();
    } else {
      ctx.strokeStyle = cor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };
  linha("corte_mw", "#f97316", true);
  linha("referencia_mw", "#3b82f6", false);
  linha("geracao_mw", "#22c55e", false);
  linha("corte_mw", "#f97316", false);
}

// ----- notificacoes -----

async function ativarNotificacoes() {
  if (!("Notification" in window)) {
    alert("Este navegador não suporta notificações.");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    alert("Você precisa permitir as notificações no navegador.");
    atualizarEstadoNotif();
    return;
  }
  if ("periodicSync" in (await navigator.serviceWorker.ready)) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.periodicSync.register("verificar-restricao", {
        minInterval: Math.max(15, Number($("frequencia").value)) * 60 * 1000,
      });
    } catch (e) {
      console.warn("periodicSync recusado", e);
    }
  }
  atualizarEstadoNotif();
  notificar("Alertas ativados", "Você receberá uma notificação quando o corte ultrapassar o limite.");
}

function atualizarEstadoNotif() {
  const el = $("estado-notif");
  if (!("Notification" in window)) {
    el.textContent = "Este navegador não suporta notificações.";
    return;
  }
  const p = Notification.permission;
  if (p === "granted") el.textContent = "Notificações ativas. O app verifica em primeiro plano; em navegadores compatíveis também em segundo plano.";
  else if (p === "denied") el.textContent = "Notificações bloqueadas. Ajuste nas permissões do site.";
  else el.textContent = "Notificações não ativadas.";
}

function notificar(titulo, corpo) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  navigator.serviceWorker?.controller?.postMessage({
    tipo: "notificar",
    titulo,
    corpo,
    tag: "restricao-" + Date.now(),
  });
  try {
    new Notification(titulo, { body: corpo, icon: "/app/icone-192.png" });
  } catch {
    // sem SW controlador, fallback silencioso
  }
}

function verificarLimite(ap, rotulo) {
  const c = estado();
  const limite = Number(c.limite || 100);
  const corte = somaMonitoradas(ap);
  if (corte < limite) return;
  const chave = `${ap.data}:${c.complexo || "sin"}`;
  if (localStorage.getItem(CHAVE_ULT) === chave) return;
  localStorage.setItem(CHAVE_ULT, chave);
  notificar(
    `Restrição alta em ${rotulo}`,
    `${fmt(corte, 1)} MWh de corte no dia ${ap.data} (limite ${limite} MWh).`
  );
}

function agendarTimer() {
  if (timer) clearInterval(timer);
  const min = Number($("frequencia").value) || 60;
  timer = setInterval(carregar, min * 60 * 1000);
}

// ----- instalar PWA -----

let promptInstalar = null;
function botaoInstalar() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    promptInstalar = e;
    $("btn-instalar").classList.remove("oculto");
  });
  $("btn-instalar").addEventListener("click", async () => {
    if (!promptInstalar) return;
    promptInstalar.prompt();
    await promptInstalar.userChoice;
    promptInstalar = null;
    $("btn-instalar").classList.add("oculto");
  });
}

document.addEventListener("DOMContentLoaded", iniciar);
