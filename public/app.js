// Painel web de restricao de geracao (ONS).

const $ = (id) => document.getElementById(id);
const fmtNumero = (n, casas = 1) =>
  (n ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

let mapa;
let camadaMarcadores;
let catalogo = { complexos: [], estados: {} };
let ultimaApuracao = null;

async function iniciar() {
  const hoje = new Date();
  hoje.setDate(hoje.getDate() - 2);
  $("data").value = hoje.toISOString().slice(0, 10);

  catalogo = await carregarCatalogo();
  montarMapa();

  $("atualizar").addEventListener("click", carregar);
  $("fonte").addEventListener("change", carregar);
  $("data").addEventListener("change", carregar);
  $("filtro").addEventListener("keydown", (e) => {
    if (e.key === "Enter") carregar();
  });

  carregar();
}

async function carregarCatalogo() {
  try {
    const r = await fetch("/data/usinas.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error("catalogo indisponivel", e);
    return { complexos: [], estados: {} };
  }
}

function montarMapa() {
  mapa = L.map("mapa", { zoomControl: true }).setView([-14.5, -47.5], 4);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(mapa);
  camadaMarcadores = L.layerGroup().addTo(mapa);
}

function localizar(usina) {
  const nome = (usina.usina || "").toUpperCase();
  for (const c of catalogo.complexos) {
    if (nome.includes(c.chave)) return { lat: c.lat, lng: c.lng, complexo: c.nome };
  }
  const uf = (usina.estado || "").toUpperCase();
  const e = catalogo.estados[uf];
  if (e) return { lat: e.lat + (Math.random() - 0.5) * 0.6, lng: e.lng + (Math.random() - 0.5) * 0.6, complexo: null };
  return null;
}

function corDaFonte(fonte) {
  return fonte === "fotovoltaica" ? "#facc15" : "#38bdf8";
}

function raioDoCorte(mwh, maximo) {
  const min = 6;
  const max = 26;
  if (!maximo) return min;
  return min + (max - min) * Math.min(1, mwh / maximo);
}

function iconePin(cor, raio) {
  const html = `<div class="pin" style="width:${raio * 2}px;height:${raio * 2}px;background:${cor};"></div>`;
  return L.divIcon({ html, className: "pin-envolve", iconSize: [raio * 2, raio * 2] });
}

function renderizarMapa(apuracao) {
  camadaMarcadores.clearLayers();
  const usinas = [...(apuracao.monitoradas || []), ...(apuracao.top || [])];
  const mapaUsinas = new Map();
  usinas.forEach((u) => mapaUsinas.set(u.usina, u));
  const lista = [...mapaUsinas.values()].filter((u) => u.corte_mwh > 0);
  if (!lista.length) return;
  const maxCorte = Math.max(...lista.map((u) => u.corte_mwh));

  const bounds = [];
  lista.forEach((u) => {
    const loc = localizar(u);
    if (!loc) return;
    const raio = raioDoCorte(u.corte_mwh, maxCorte);
    const marker = L.marker([loc.lat, loc.lng], { icon: iconePin(corDaFonte(apuracao.fonte), raio) });
    const razao = u.razoes && Object.keys(u.razoes).length ? Object.entries(u.razoes).sort((a, b) => b[1] - a[1])[0][0] : "-";
    marker.bindPopup(`
      <h3>${u.usina}</h3>
      <p>${loc.complexo || "Localização aproximada por UF"}</p>
      <p>Estado: ${u.estado || "-"} • Subsistema: ${u.subsistema || "-"}</p>
      <p>Corte: <strong>${fmtNumero(u.corte_mwh)} MWh</strong> (${fmtNumero(u.perda_pct, 1)}%)</p>
      <p>Horas restritas: ${fmtNumero(u.horas_restritas, 1)} h</p>
      <p>Razão predominante: ${razao}</p>
    `);
    marker.addTo(camadaMarcadores);
    bounds.push([loc.lat, loc.lng]);
  });

  if (bounds.length) {
    mapa.fitBounds(bounds, { padding: [30, 30], maxZoom: 7 });
  }
}

function renderizarTop(apuracao) {
  const ol = $("top");
  ol.innerHTML = "";
  const lista = (apuracao.top || []).filter((u) => u.corte_mwh > 0);
  if (!lista.length) {
    ol.innerHTML = "<li><span class='nome'>Sem restrições relevantes no dia.</span></li>";
    return;
  }
  lista.forEach((u) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div class="nome">${u.usina}</div>
        <div class="meta">${u.estado || "-"} • ${fmtNumero(u.perda_pct, 1)}% • ${fmtNumero(u.horas_restritas, 1)} h</div>
      </div>
      <div class="valor">${fmtNumero(u.corte_mwh)} MWh</div>
    `;
    li.addEventListener("click", () => {
      $("filtro").value = u.usina.split(" ")[0];
      carregar();
    });
    ol.appendChild(li);
  });
}

function renderizarResumo(apuracao) {
  const t = apuracao.total || {};
  $("corte-total").textContent = fmtNumero(t.corte_mwh, 1);
  $("perda-pct").textContent = fmtNumero(t.perda_pct, 2);
  $("usinas-corte").textContent = t.usinas_com_restricao ?? "—";
  $("usinas-total").textContent = t.usinas_total ?? "—";
  const link = $("origem");
  link.href = apuracao.origem || "#";
  link.textContent = apuracao.origem ? apuracao.origem.split("/").pop() : "—";
}

function renderizarGrafico(pontos) {
  const canvas = $("grafico");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  if (!pontos.length) {
    ctx.fillStyle = "#92a2c9";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Sem série disponível para o recorte atual.", w / 2, h / 2);
    return;
  }

  const padE = 50, padS = 30, padD = 20, padT = 20;
  const areaW = w - padE - padD;
  const areaH = h - padT - padS;

  const maxV = Math.max(1, ...pontos.map((p) => Math.max(p.geracao_mw, p.referencia_mw, p.corte_mw)));
  const escalaX = (i) => padE + (i * areaW) / Math.max(1, pontos.length - 1);
  const escalaY = (v) => padT + areaH - (v / maxV) * areaH;

  // grade
  ctx.strokeStyle = "#263353";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#92a2c9";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = (maxV * i) / 4;
    const y = escalaY(v);
    ctx.beginPath();
    ctx.moveTo(padE, y);
    ctx.lineTo(w - padD, y);
    ctx.stroke();
    ctx.fillText(fmtNumero(v, 0), padE - 6, y + 3);
  }
  // eixo x, marca a cada 6h
  ctx.textAlign = "center";
  pontos.forEach((p, i) => {
    if (i % 12 !== 0) return;
    const hora = (p.instante || "").slice(11, 16);
    const x = escalaX(i);
    ctx.fillText(hora, x, h - padS + 16);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + areaH);
    ctx.stroke();
  });

  const desenhar = (chave, cor, preencher) => {
    ctx.beginPath();
    pontos.forEach((p, i) => {
      const x = escalaX(i);
      const y = escalaY(p[chave] || 0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (preencher) {
      ctx.lineTo(escalaX(pontos.length - 1), padT + areaH);
      ctx.lineTo(escalaX(0), padT + areaH);
      ctx.closePath();
      ctx.fillStyle = cor + "33";
      ctx.fill();
    } else {
      ctx.strokeStyle = cor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };

  desenhar("corte_mw", "#f97316", true);
  desenhar("referencia_mw", "#3b82f6", false);
  desenhar("geracao_mw", "#22c55e", false);
  desenhar("corte_mw", "#f97316", false);
}

async function carregar() {
  const fonte = $("fonte").value;
  const data = $("data").value;
  const filtro = $("filtro").value.trim();
  $("status").textContent = "Carregando…";
  $("status").classList.remove("erro");

  try {
    const params = new URLSearchParams({ fonte, data });
    if (filtro) params.set("usina", filtro);
    const [apResp, sResp] = await Promise.all([
      fetch(`/api/restricao?${params}`),
      fetch(`/api/serie?${params}`),
    ]);
    if (!apResp.ok) throw new Error(`Apuração indisponível (HTTP ${apResp.status})`);
    const apuracao = await apResp.json();
    const serie = sResp.ok ? await sResp.json() : { pontos: [] };
    ultimaApuracao = apuracao;

    renderizarResumo(apuracao);
    renderizarTop(apuracao);
    renderizarMapa(apuracao);
    renderizarGrafico(serie.pontos || []);
    $("status").textContent = `Atualizado ${new Date().toLocaleTimeString("pt-BR")} • ${apuracao.linhas_lidas} registros lidos`;
  } catch (e) {
    console.error(e);
    $("status").textContent = e.message || "Falha ao carregar dados.";
    $("status").classList.add("erro");
  }
}

window.addEventListener("resize", () => {
  if (ultimaApuracao) renderizarGrafico((window._serie && window._serie.pontos) || []);
});

document.addEventListener("DOMContentLoaded", iniciar);
