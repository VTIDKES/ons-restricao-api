# API de Informativos de Restrição de Geração (ONS)

API serverless que lê os dados de constrained-off publicados pelo ONS no Portal
de Dados Abertos, apura o corte por usina e entrega um informativo diário.

## Fonte dos dados

Quatro conjuntos, todos em base semi-horária e licença CC-BY:

| Conjunto | Slug |
|---|---|
| Eólicas por usina | `restricao_coff_eolica_usi` |
| Eólicas detalhado | `restricao_coff_eolica_detail` |
| Fotovoltaicas por usina | `restricao_coff_fotovoltaica` |
| Fotovoltaicas detalhado | `restricao_coff_fotovoltaica_detail` |

Os arquivos ficam num bucket S3 público, um por mês, em CSV, XLSX e PARQUET.
Esta API lê **só o PARQUET**:

```
s3://ons-aws-prod-opendata/dataset/restricao_coff_eolica_tm/RESTRICAO_COFF_EOLICA_2026_08.parquet
```

O ONS atualiza diariamente às 12h e às 19h.

## Por que PARQUET

O acesso é anônimo, via `pyarrow.fs.S3FileSystem`, o que permite leitura por
faixa em vez de baixar o arquivo inteiro. Duas economias se somam:

- **Poda de colunas**: das quinze colunas do arquivo, só oito são lidas.
- **Poda de row groups**: o filtro por data é empurrado para o scan, e o pyarrow
  descarta pelas estatísticas do arquivo os blocos que não contêm o dia pedido.

O que no CSV era um download de centenas de MB no fim do mês vira alguns MB de
leitura. A agregação também é vetorizada em Arrow, sem loop Python por linha.

## Cálculo do corte

Fórmula usual do setor, aplicada por intervalo semi-horário:

```
se val_geracaolimitada não é nulo e val_geracaoreferencia > val_geracao:
    corte = val_geracaoreferencia - val_geracao
senão:
    corte = 0
```

Os valores são potência média em MW no intervalo, então a energia sai
multiplicando por 0,5 h.

## Endpoints

| Rota | O que faz |
|---|---|
| `GET /api/saude` | Estado da API, cache e webhook |
| `GET /api/schema?fonte=eolica` | Schema real do parquet, nome e tipo de cada coluna |
| `GET /api/restricao?fonte=eolica&data=2026-08-15&usina=COREMAS` | Apuração do dia por usina |
| `GET /api/informativo?data=2026-08-15` | Informativo pronto em texto |
| `GET /api/cron/informativo` | Chamado pelo Vercel Cron, apura e envia |

Sem `data`, o padrão é D-2, porque a apuração do ONS tem defasagem.

## Deploy

```bash
npm i -g vercel
vercel
vercel env add USINAS
vercel env add WEBHOOK_URL
vercel --prod
```

O runtime Python do Vercel detecta o FastAPI pelo `requirements.txt` e carrega
a variável `app` do `main.py`. O cron já está declarado no `vercel.json` para
rodar às 23h UTC, ou seja, 20h de Brasília, depois da atualização das 19h do ONS.

Variáveis de ambiente estão no `.env.example`.

## Cache

Cada invocação é um processo novo, então a apuração é guardada no Upstash Redis
pela API REST. Sem as variáveis do Upstash, a API cai para um cache em memória,
que serve para rodar local mas não persiste no Vercel.

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

Para desenvolver sem tocar no S3, baixe os `.parquet` do mês, aponte
`ONS_PARQUET_DIR` para a pasta e a API lê dali, mantendo o nome original dos
arquivos.

## Envio do informativo

O `WEBHOOK_URL` recebe um POST JSON com `texto` e `dados`. Isso pluga direto
num fluxo do n8n, no `/message/sendText` da Evolution API ou num bot de
Telegram, sem prender a API a um canal.

## Limitações que valem saber

- **Não é tempo real.** É apuração consolidada, com alguns dias de defasagem, e
  o ONS avisa que os números podem ser revisados depois de publicados. Para
  alarme de restrição no momento em que ela acontece, a origem é o SINTEGRE ou
  o próprio SCADA.
- **Peso do bundle.** O pyarrow puxa numpy junto e ocupa bem mais que o leitor
  de CSV, embora fique confortavelmente abaixo do limite padrão de 500 MB do
  Vercel. O custo aparece no cold start, não no tempo de resposta.
- **Poda de row group depende da ordenação do arquivo.** Se o ONS gravar o mês
  ordenado por usina em vez de por instante, as estatísticas de `din_instante`
  vão se sobrepor entre os blocos e o scan lerá mais do que o necessário. A
  poda de colunas continua valendo de qualquer forma. Se notar lentidão,
  `/api/schema` e o `metadata` do parquet mostram como ele está particionado.
- **O schema pode mudar.** Já mudou antes. O `ons.py` aceita nomes alternativos
  de coluna, lida com `din_instante` como timestamp ou como string, e
  `/api/schema` mostra o layout real quando algo quebrar.
- **Atribuição.** A licença é CC-BY: se publicar, credite o ONS e informe as
  alterações feitas.
