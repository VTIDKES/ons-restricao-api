"""
API de informativos de restricao de geracao do ONS.

Entrypoint do Vercel: o runtime Python procura por main.py e carrega a
variavel de modulo `app`.
"""

from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import PlainTextResponse

import informativo
import store
from ons import FONTES, ONSIndisponivel, apurar_dia, schema_do_mes, ultimo_dia_disponivel

logging.basicConfig(level=logging.INFO)

CRON_SECRET = os.environ.get("CRON_SECRET", "")
USINAS_PADRAO = [u for u in os.environ.get("USINAS", "").split(",") if u.strip()]
FONTES_CRON = [
    f.strip() for f in os.environ.get("FONTES", "eolica,fotovoltaica").split(",")
    if f.strip() in FONTES
]

app = FastAPI(
    title="API de Restricao de Geracao (ONS)",
    description=(
        "Informativos de constrained-off de usinas eolicas e fotovoltaicas, "
        "a partir do Portal de Dados Abertos do ONS (CC-BY). "
        "Os dados sao de apuracao consolidada e podem ser revisados pelo ONS "
        "apos a publicacao; nao servem como alarme em tempo real."
    ),
    version="1.0.0",
)


def _parse_data(valor: str | None) -> date:
    if not valor:
        return date.today() - timedelta(days=2)
    try:
        return datetime.strptime(valor, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "data invalida, use o formato AAAA-MM-DD")


def _apuracao(fonte: str, dia: date, filtro: list[str], forcar: bool = False) -> dict:
    """Le do cache; se nao houver, apura no ONS e guarda."""
    chave = store.chave_apuracao(fonte, dia.isoformat())
    if not forcar:
        cache = store.ler(chave)
        if cache:
            cache["cache"] = True
            return cache
    try:
        dados = apurar_dia(fonte, dia, filtro)
    except ONSIndisponivel as e:
        raise HTTPException(503, str(e))
    store.salvar(chave, dados)
    dados["cache"] = False
    return dados


@app.get("/api/saude")
def saude():
    return {
        "ok": True,
        "cache_externo": store.ativo(),
        "fontes": list(FONTES),
        "usinas_monitoradas": USINAS_PADRAO,
        "webhook_configurado": bool(informativo.WEBHOOK_URL),
    }


@app.get("/api/schema")
def schema(fonte: str = Query("eolica"), mes: str | None = None):
    """
    Devolve o schema real do parquet do ONS, com nome e tipo de cada coluna.
    Serve para conferir quando o ONS mexer no layout.
    """
    if fonte not in FONTES:
        raise HTTPException(400, f"fonte deve ser uma de {list(FONTES)}")
    ref = _parse_data(f"{mes}-01") if mes else date.today()
    try:
        return {"fonte": fonte, "mes": f"{ref.year}-{ref.month:02d}",
                **schema_do_mes(fonte, ref.year, ref.month)}
    except ONSIndisponivel as e:
        raise HTTPException(503, str(e))


@app.get("/api/restricao")
def restricao(
    fonte: str = Query("eolica"),
    data: str | None = Query(None, description="AAAA-MM-DD, padrao D-2"),
    usina: str | None = Query(None, description="trecho do nome, separado por virgula"),
    forcar: bool = Query(False, description="ignora o cache e reapura"),
):
    """Apuracao do dia por usina, com totais do SIN e recorte monitorado."""
    if fonte not in FONTES:
        raise HTTPException(400, f"fonte deve ser uma de {list(FONTES)}")
    filtro = [u for u in (usina or "").split(",") if u.strip()] or USINAS_PADRAO
    return _apuracao(fonte, _parse_data(data), filtro, forcar)


@app.get("/api/informativo", response_class=PlainTextResponse)
def texto_informativo(
    data: str | None = Query(None),
    usina: str | None = Query(None),
):
    """O informativo pronto, em texto, do jeito que sai no WhatsApp."""
    filtro = [u for u in (usina or "").split(",") if u.strip()] or USINAS_PADRAO
    dia = _parse_data(data)
    apuracoes = []
    for fonte in FONTES_CRON:
        try:
            apuracoes.append(_apuracao(fonte, dia, filtro))
        except HTTPException:
            continue
    if not apuracoes:
        raise HTTPException(503, f"sem apuracao disponivel para {dia.isoformat()}")
    return informativo.montar_texto(apuracoes)


@app.get("/api/cron/informativo")
def cron_informativo(authorization: str | None = Header(None)):
    """
    Chamado pelo Vercel Cron. Procura o dia mais recente com apuracao,
    monta o informativo e envia para o webhook.
    """
    if CRON_SECRET and authorization != f"Bearer {CRON_SECRET}":
        raise HTTPException(401, "nao autorizado")

    ontem = date.today() - timedelta(days=1)
    apuracoes = []
    for fonte in FONTES_CRON:
        try:
            dia = ultimo_dia_disponivel(fonte, ontem)
            apuracoes.append(_apuracao(fonte, dia, USINAS_PADRAO))
        except (ONSIndisponivel, HTTPException) as e:
            logging.warning("fonte %s sem dados: %s", fonte, e)

    if not apuracoes:
        return {"ok": False, "motivo": "nenhuma fonte com apuracao disponivel"}

    texto = informativo.montar_texto(apuracoes)
    envio = informativo.enviar(texto, apuracoes)
    return {"ok": True, "data": apuracoes[0]["data"], "envio": envio, "texto": texto}
