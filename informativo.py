"""
Monta o texto do informativo e empurra para fora.

O envio e generico de proposito: um POST JSON para WEBHOOK_URL. Isso encaixa
tanto num fluxo do n8n quanto no /message/sendText da Evolution API ou num
bot de Telegram, sem prender a API a um canal especifico.
"""

from __future__ import annotations

import logging
import os

import requests

log = logging.getLogger("informativo")

WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "")
WEBHOOK_TOKEN = os.environ.get("WEBHOOK_TOKEN", "")


def _mwh(v: float) -> str:
    return f"{v:,.1f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _pct(v: float) -> str:
    return f"{v:.1f}".replace(".", ",")


def montar_texto(apuracoes: list[dict]) -> str:
    """Recebe uma ou mais apuracoes (eolica, fotovoltaica) e devolve o texto."""
    if not apuracoes:
        return "Sem apuracao disponivel."

    data = apuracoes[0]["data"]
    linhas = [
        "*Informativo de Restricao de Geracao (constrained-off)*",
        f"Data de referencia: {data}",
        "",
    ]

    for ap in apuracoes:
        t = ap["total"]
        linhas.append(f"*{ap['rotulo'].upper()}*")
        linhas.append(
            f"Corte total no SIN: {_mwh(t['corte_mwh'])} MWh "
            f"({_pct(t['perda_pct'])}% da geracao de referencia)"
        )
        linhas.append(
            f"Usinas com restricao: {t['usinas_com_restricao']} de {t['usinas_total']}"
        )

        if ap.get("monitoradas"):
            linhas.append("")
            linhas.append("Usinas monitoradas:")
            for u in ap["monitoradas"]:
                if u["corte_mwh"] <= 0:
                    linhas.append(f"  - {u['usina']}: sem restricao")
                    continue
                razao = max(u["razoes"], key=u["razoes"].get) if u["razoes"] else "-"
                linhas.append(
                    f"  - {u['usina']}: {_mwh(u['corte_mwh'])} MWh "
                    f"({_pct(u['perda_pct'])}%), {u['horas_restritas']} h, razao {razao}"
                )

        if ap.get("top"):
            linhas.append("")
            linhas.append("Maiores cortes do SIN:")
            for u in ap["top"][:5]:
                linhas.append(
                    f"  {u['usina']} ({u['estado'] or '-'}): "
                    f"{_mwh(u['corte_mwh'])} MWh ({_pct(u['perda_pct'])}%)"
                )
        linhas.append("")

    linhas.append(
        "Fonte: ONS, Portal de Dados Abertos (CC-BY). Apuracao consolidada, "
        "sujeita a revisao pelo proprio ONS apos a publicacao."
    )
    return "\n".join(linhas)


def enviar(texto: str, apuracoes: list[dict]) -> dict:
    """POST no webhook configurado. Sem webhook, so devolve o texto."""
    if not WEBHOOK_URL:
        return {"enviado": False, "motivo": "WEBHOOK_URL nao configurada"}

    headers = {"Content-Type": "application/json"}
    if WEBHOOK_TOKEN:
        headers["Authorization"] = f"Bearer {WEBHOOK_TOKEN}"

    corpo = {
        "tipo": "informativo_restricao_ons",
        "data": apuracoes[0]["data"] if apuracoes else None,
        "texto": texto,
        "dados": apuracoes,
    }
    try:
        r = requests.post(WEBHOOK_URL, json=corpo, headers=headers, timeout=20)
        r.raise_for_status()
        return {"enviado": True, "status": r.status_code}
    except requests.RequestException as e:
        log.error("falha no webhook: %s", e)
        return {"enviado": False, "motivo": str(e)}
