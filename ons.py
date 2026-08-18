"""
Cliente do Portal de Dados Abertos do ONS, leitura em PARQUET.

Datasets usados (constrained-off, base semi-horaria, CC-BY):
  eolica       -> dataset/restricao_coff_eolica_tm/RESTRICAO_COFF_EOLICA_AAAA_MM.parquet
  fotovoltaica -> dataset/restricao_coff_fotovoltaica_tm/RESTRICAO_COFF_FOTOVOLTAICA_AAAA_MM.parquet

Por que PARQUET e nao CSV: o arquivo e colunar e comprimido, entao a leitura
puxa so as colunas usadas e o pyarrow descarta os row groups fora da data pelas
estatisticas do proprio arquivo. O que no CSV era um download de centenas de MB
vira alguns MB de leitura por faixa direto no S3.

A agregacao tambem e vetorizada em Arrow, sem loop Python sobre as linhas.
"""

from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.dataset as ds
from pyarrow import fs

log = logging.getLogger("ons")

BUCKET = "ons-aws-prod-opendata"
HTTPS = f"https://{BUCKET}.s3.amazonaws.com/dataset"

# Diretorio local com os .parquet, para desenvolver sem tocar no S3.
DIR_LOCAL = os.environ.get("ONS_PARQUET_DIR", "")

FONTES = {
    "eolica": {
        "pasta": "restricao_coff_eolica_tm",
        "prefixo": "RESTRICAO_COFF_EOLICA",
        "rotulo": "Eolica",
    },
    "fotovoltaica": {
        "pasta": "restricao_coff_fotovoltaica_tm",
        "prefixo": "RESTRICAO_COFF_FOTOVOLTAICA",
        "rotulo": "Fotovoltaica",
    },
}

# O ONS mantem os nomes de coluna estaveis, mas ja houve mudanca de schema.
# Cada campo aceita mais de um nome; o primeiro presente no arquivo vence.
CAMPOS = {
    "instante": ["din_instante"],
    "usina": ["nom_usina", "nom_conjunto"],
    "subsistema": ["id_subsistema", "nom_subsistema"],
    "estado": ["id_estado", "nom_estado"],
    "geracao": ["val_geracao"],
    "limitada": ["val_geracaolimitada"],
    "referencia": ["val_geracaoreferencia"],
    "razao": ["cod_razaorestricao"],
}
OBRIGATORIOS = {"instante", "usina", "geracao", "limitada", "referencia"}

_fs_cache: fs.S3FileSystem | None = None


class ONSIndisponivel(RuntimeError):
    """O ONS nao respondeu, o arquivo do mes ainda nao existe ou o dia nao foi apurado."""


def nome_arquivo(fonte: str, ano: int, mes: int) -> str:
    if fonte not in FONTES:
        raise ValueError(f"fonte invalida: {fonte}")
    return f"{FONTES[fonte]['prefixo']}_{ano:04d}_{mes:02d}.parquet"


def url_mensal(fonte: str, ano: int, mes: int) -> str:
    """URL publica do arquivo, so para registrar a procedencia na resposta."""
    return f"{HTTPS}/{FONTES[fonte]['pasta']}/{nome_arquivo(fonte, ano, mes)}"


def _filesystem() -> fs.S3FileSystem:
    """S3 anonimo. A regiao e resolvida uma vez e reaproveitada no processo."""
    global _fs_cache
    if _fs_cache is None:
        try:
            regiao = fs.resolve_s3_region(BUCKET)
        except Exception as e:  # rede fora do ar, bucket movido, etc.
            log.warning("nao resolvi a regiao do bucket (%s), assumindo us-east-1", e)
            regiao = "us-east-1"
        _fs_cache = fs.S3FileSystem(anonymous=True, region=regiao)
    return _fs_cache


def abrir(fonte: str, ano: int, mes: int) -> ds.Dataset:
    """Abre o parquet do mes, no S3 ou no diretorio local."""
    arquivo = nome_arquivo(fonte, ano, mes)
    try:
        if DIR_LOCAL:
            caminho = os.path.join(DIR_LOCAL, arquivo)
            if not os.path.exists(caminho):
                raise FileNotFoundError(caminho)
            return ds.dataset(caminho, format="parquet")
        caminho = f"{BUCKET}/dataset/{FONTES[fonte]['pasta']}/{arquivo}"
        return ds.dataset(caminho, format="parquet", filesystem=_filesystem())
    except FileNotFoundError as e:
        raise ONSIndisponivel(f"arquivo ainda nao publicado: {arquivo}") from e
    except (pa.ArrowInvalid, OSError) as e:
        raise ONSIndisponivel(f"falha ao abrir o parquet do ONS ({arquivo}): {e}") from e


def _mapear(schema: pa.Schema) -> dict[str, str]:
    """Liga cada campo logico ao nome real da coluna no arquivo."""
    presentes = {n.lower(): n for n in schema.names}
    idx: dict[str, str] = {}
    for campo, candidatos in CAMPOS.items():
        for c in candidatos:
            if c in presentes:
                idx[campo] = presentes[c]
                break
    faltando = OBRIGATORIOS - idx.keys()
    if faltando:
        raise ONSIndisponivel(
            f"schema inesperado do ONS, faltam colunas: {sorted(faltando)} "
            f"(recebido: {schema.names})"
        )
    return idx


def _filtro_do_dia(schema: pa.Schema, coluna: str, dia: date) -> ds.Expression:
    """
    Recorte [dia, dia+1). Serve tanto se din_instante vier como timestamp
    quanto como string, porque 'AAAA-MM-DD HH:MM:SS' ordena lexicograficamente
    na mesma ordem do tempo.
    """
    tipo = schema.field(coluna).type
    if pa.types.is_timestamp(tipo) or pa.types.is_date(tipo):
        ini = datetime(dia.year, dia.month, dia.day)
        fim = ini + timedelta(days=1)
        alvo_ini, alvo_fim = pa.scalar(ini, type=tipo), pa.scalar(fim, type=tipo)
    else:
        alvo_ini = dia.isoformat()
        alvo_fim = (dia + timedelta(days=1)).isoformat()
    return (pc.field(coluna) >= alvo_ini) & (pc.field(coluna) < alvo_fim)


def ler_dia(fonte: str, dia: date) -> tuple[pa.Table, dict[str, str]]:
    """
    Devolve a tabela do dia com as colunas usadas e o mapa de nomes.

    Um dia inteiro do SIN sao poucas dezenas de milhares de linhas, entao cabe
    na memoria sem problema. O que pesaria seria o mes todo, e e justamente
    isso que o filtro por row group evita ler.
    """
    dataset = abrir(fonte, dia.year, dia.month)
    idx = _mapear(dataset.schema)
    try:
        tabela = dataset.to_table(
            columns={campo: ds.field(col) for campo, col in idx.items()},
            filter=_filtro_do_dia(dataset.schema, idx["instante"], dia),
        )
    except (pa.ArrowInvalid, OSError) as e:
        raise ONSIndisponivel(f"falha ao ler o parquet: {e}") from e

    if tabela.num_rows == 0:
        raise ONSIndisponivel(
            f"sem dados para {dia.isoformat()} em {fonte}; "
            "a apuracao do ONS costuma ter alguns dias de defasagem"
        )
    return tabela, idx


def _corte_mw(tabela: pa.Table) -> pa.ChunkedArray:
    """
    Curtailment instantaneo em MW, na formula usual do setor:
    se val_geracaolimitada nao e nulo e val_geracaoreferencia > val_geracao,
    o corte e a diferenca; senao, zero.
    """
    ger = pc.cast(tabela["geracao"], pa.float64())
    ref = pc.cast(tabela["referencia"], pa.float64())
    lim = tabela["limitada"]
    restrito = pc.and_kleene(pc.is_valid(lim), pc.greater(ref, ger))
    diff = pc.subtract(ref, ger)
    return pc.if_else(pc.fill_null(restrito, False), diff, pa.scalar(0.0))


def _por_usina(tabela: pa.Table, tem: dict[str, str]) -> list[dict]:
    """Agrega o dia por usina, tudo em Arrow, sem loop sobre as linhas."""
    meia_hora = pa.scalar(0.5)  # MW medio no intervalo semi-horario -> MWh
    corte = _corte_mw(tabela)

    t = pa.table({
        "usina": tabela["usina"],
        "subsistema": tabela["subsistema"] if "subsistema" in tem else pa.nulls(tabela.num_rows, pa.string()),
        "estado": tabela["estado"] if "estado" in tem else pa.nulls(tabela.num_rows, pa.string()),
        "corte_mwh": pc.multiply(corte, meia_hora),
        "geracao_mwh": pc.multiply(pc.cast(tabela["geracao"], pa.float64()), meia_hora),
        "referencia_mwh": pc.multiply(pc.cast(tabela["referencia"], pa.float64()), meia_hora),
        "restrito": pc.cast(pc.greater(corte, pa.scalar(0.0)), pa.int64()),
    })

    agg = t.group_by(["usina", "subsistema", "estado"]).aggregate([
        ("corte_mwh", "sum"),
        ("geracao_mwh", "sum"),
        ("referencia_mwh", "sum"),
        ("restrito", "sum"),
    ])

    # razao predominante entre os intervalos efetivamente restritos
    razoes: dict[str, dict[str, int]] = {}
    if "razao" in tem:
        r = pa.table({
            "usina": tabela["usina"],
            "razao": pc.cast(tabela["razao"], pa.string()),
            "n": pc.cast(pc.greater(corte, pa.scalar(0.0)), pa.int64()),
        })
        cont = r.group_by(["usina", "razao"]).aggregate([("n", "sum")]).to_pylist()
        for linha in cont:
            if not linha["n_sum"]:
                continue
            razoes.setdefault(linha["usina"], {})[linha["razao"] or "NAO INFORMADA"] = linha["n_sum"]

    saida = []
    for linha in agg.to_pylist():
        corte_mwh = linha["corte_mwh_sum"] or 0.0
        ref_mwh = linha["referencia_mwh_sum"] or 0.0
        nome = linha["usina"] or "(sem nome)"
        saida.append({
            "usina": nome,
            "subsistema": linha["subsistema"],
            "estado": linha["estado"],
            "corte_mwh": round(corte_mwh, 3),
            "geracao_mwh": round(linha["geracao_mwh_sum"] or 0.0, 3),
            "referencia_mwh": round(ref_mwh, 3),
            "perda_pct": round(100.0 * corte_mwh / ref_mwh, 2) if ref_mwh > 0 else 0.0,
            "horas_restritas": round((linha["restrito_sum"] or 0) * 0.5, 1),
            "razoes": razoes.get(nome, {}),
        })
    saida.sort(key=lambda u: u["corte_mwh"], reverse=True)
    return saida


def _serie_semi_horaria(tabela: pa.Table, tem: dict[str, str], alvos: list[str]) -> list[dict]:
    """
    Serie semi-horaria (48 pontos/dia) por conjunto de usinas monitoradas.

    Se `alvos` vier vazio, agrega o SIN inteiro. Cada ponto traz corte,
    geracao e referencia em MW medios do intervalo.
    """
    if alvos:
        nomes = pc.utf8_upper(pc.cast(tabela["usina"], pa.string()))
        mask = None
        for alvo in alvos:
            m = pc.match_substring(nomes, alvo.strip().upper())
            mask = m if mask is None else pc.or_kleene(mask, m)
        if mask is not None:
            tabela = tabela.filter(mask)
    if tabela.num_rows == 0:
        return []

    corte = _corte_mw(tabela)
    t = pa.table({
        "instante": pc.cast(tabela["instante"], pa.string()),
        "corte_mw": corte,
        "geracao_mw": pc.cast(tabela["geracao"], pa.float64()),
        "referencia_mw": pc.cast(tabela["referencia"], pa.float64()),
    })
    agg = t.group_by(["instante"]).aggregate([
        ("corte_mw", "sum"),
        ("geracao_mw", "sum"),
        ("referencia_mw", "sum"),
    ]).to_pylist()
    agg.sort(key=lambda p: p["instante"])
    return [
        {
            "instante": p["instante"],
            "corte_mw": round(p["corte_mw_sum"] or 0.0, 2),
            "geracao_mw": round(p["geracao_mw_sum"] or 0.0, 2),
            "referencia_mw": round(p["referencia_mw_sum"] or 0.0, 2),
        }
        for p in agg
    ]


def apurar_serie(fonte: str, dia: date, filtro: list[str] | None = None) -> dict:
    """Serie semi-horaria do dia, opcionalmente recortada por trecho de nome."""
    tabela, idx = ler_dia(fonte, dia)
    alvos = [t.strip() for t in (filtro or []) if t.strip()]
    pontos = _serie_semi_horaria(tabela, idx, alvos)
    return {
        "fonte": fonte,
        "rotulo": FONTES[fonte]["rotulo"],
        "data": dia.isoformat(),
        "recorte": alvos,
        "pontos": pontos,
    }


def apurar_dia(fonte: str, dia: date, filtro: list[str] | None = None) -> dict:
    """
    Apuracao do dia, pronta para cachear e servir.

    `filtro` e uma lista de trechos de nome; as usinas que casarem entram no
    recorte "monitoradas". Os totais do SIN continuam sobre o conjunto inteiro.
    """
    tabela, idx = ler_dia(fonte, dia)
    usinas = _por_usina(tabela, idx)

    alvos = [t.strip().upper() for t in (filtro or []) if t.strip()]
    monitoradas = [u for u in usinas if any(a in u["usina"].upper() for a in alvos)] if alvos else []

    total_corte = sum(u["corte_mwh"] for u in usinas)
    total_ref = sum(u["referencia_mwh"] for u in usinas)

    return {
        "fonte": fonte,
        "rotulo": FONTES[fonte]["rotulo"],
        "data": dia.isoformat(),
        "apurado_em": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "origem": url_mensal(fonte, dia.year, dia.month),
        "formato": "parquet",
        "linhas_lidas": tabela.num_rows,
        "total": {
            "corte_mwh": round(total_corte, 1),
            "referencia_mwh": round(total_ref, 1),
            "perda_pct": round(100.0 * total_corte / total_ref, 2) if total_ref else 0.0,
            "usinas_com_restricao": sum(1 for u in usinas if u["corte_mwh"] > 0),
            "usinas_total": len(usinas),
        },
        "monitoradas": monitoradas,
        "top": [u for u in usinas[:15] if u["corte_mwh"] > 0],
    }


def schema_do_mes(fonte: str, ano: int, mes: int) -> dict:
    """Schema real do arquivo, para conferir quando o ONS mexer nas colunas."""
    dataset = abrir(fonte, ano, mes)
    return {
        "arquivo": nome_arquivo(fonte, ano, mes),
        "colunas": [{"nome": c.name, "tipo": str(c.type)} for c in dataset.schema],
    }


def tem_dados(fonte: str, dia: date) -> bool:
    """
    Checagem barata: conta linhas do dia usando as estatisticas do parquet,
    sem materializar nada.
    """
    try:
        dataset = abrir(fonte, dia.year, dia.month)
        idx = _mapear(dataset.schema)
        return dataset.count_rows(filter=_filtro_do_dia(dataset.schema, idx["instante"], dia)) > 0
    except ONSIndisponivel:
        return False


def ultimo_dia_disponivel(fonte: str, ate: date, tentativas: int = 7) -> date:
    """Anda para tras ate achar um dia ja apurado; o ONS publica com defasagem."""
    dia = ate
    for _ in range(tentativas):
        if tem_dados(fonte, dia):
            return dia
        dia -= timedelta(days=1)
    raise ONSIndisponivel(
        f"nenhum dia com dados nos ultimos {tentativas} dias ate {ate.isoformat()}"
    )
