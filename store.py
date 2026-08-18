"""
Cache simples.

Funcao serverless nao guarda estado entre invocacoes, entao o resultado da
apuracao precisa morar fora do processo. Uso o Upstash Redis pela API REST,
sem SDK, so requests. Se as variaveis nao estiverem setadas, cai para um
dicionario em memoria, o que basta para rodar local.
"""

from __future__ import annotations

import json
import logging
import os
import time

import requests

log = logging.getLogger("store")

URL = os.environ.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")
TTL_PADRAO = 60 * 60 * 24 * 45  # 45 dias

_memoria: dict[str, tuple[float, str]] = {}


def ativo() -> bool:
    return bool(URL and TOKEN)


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def salvar(chave: str, valor: dict, ttl: int = TTL_PADRAO) -> bool:
    payload = json.dumps(valor, ensure_ascii=False)
    if not ativo():
        _memoria[chave] = (time.time() + ttl, payload)
        return True
    try:
        r = requests.post(
            f"{URL}/set/{chave}",
            params={"EX": ttl},
            data=payload.encode("utf-8"),
            headers=_headers(),
            timeout=10,
        )
        r.raise_for_status()
        return True
    except requests.RequestException as e:
        log.warning("falha ao salvar %s: %s", chave, e)
        return False


def ler(chave: str) -> dict | None:
    if not ativo():
        item = _memoria.get(chave)
        if not item or item[0] < time.time():
            return None
        return json.loads(item[1])
    try:
        r = requests.get(f"{URL}/get/{chave}", headers=_headers(), timeout=10)
        r.raise_for_status()
        bruto = r.json().get("result")
        return json.loads(bruto) if bruto else None
    except (requests.RequestException, ValueError) as e:
        log.warning("falha ao ler %s: %s", chave, e)
        return None


def chave_apuracao(fonte: str, dia: str) -> str:
    return f"restricao:{fonte}:{dia}"
