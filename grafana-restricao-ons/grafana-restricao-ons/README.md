# Dashboard de Restricao de Geracao (ONS) no Grafana

Painel Grafana em cima da sua API `ons-restricao-api`, sem precisar construir pipeline de ingestao, ETL ou banco intermediario. O Grafana consulta a API diretamente via plugin **Infinity** (`yesoreyeram-infinity-datasource`), que sabe ler JSON de uma URL e transformar em tabela ou serie temporal.

## Como isso foi validado

Nao dei pra rodar Grafana de verdade no ambiente onde montei isso (sem acesso a registry de container ali), entao o que foi testado de fato:

- Rodei a sua API localmente (`uvicorn main:app`), apontando `ONS_PARQUET_DIR` para um parquet sintetico com o mesmo schema do ONS (`din_instante`, `nom_usina`, `val_geracao`, `val_geracaolimitada`, `val_geracaoreferencia`, etc).
- Bati em `/api/restricao` e `/api/serie` de verdade e conferi o formato exato da resposta (isso e o que define os `root_selector` e `columns` do dashboard).
- O dashboard JSON foi escrito a mao com base nesse formato confirmado e no schema documentado do plugin Infinity.

O que **nao** foi confirmado com Grafana rodando de verdade: se a versao mais recente do plugin aceita exatamente esses nomes de campo (`root_selector`, `timestampFormat`, etc) sem ajuste. Historicamente sim, mas plugin de terceiro muda. Se algum painel vier vazio, veja a secao **Se algum painel nao aparecer** mais abaixo, é ajuste de 1 minuto pela interface, nao um problema de arquitetura.

## Estrutura

```
grafana-restricao-ons/
├── docker-compose.yml
├── .env.example
├── api/                        <- coloque aqui o conteudo do onsrestricaoapimain.zip
├── dados_teste/                <- parquet sintetico, so para o primeiro teste
└── grafana/
    ├── provisioning/
    │   ├── datasources/infinity.yaml
    │   └── dashboards/dashboards.yaml
    └── dashboards/restricao-ons.json
```

## Passo a passo

1. Extraia o `onsrestricaoapimain.zip` (a sua API) dentro da pasta `api/`, de forma que `api/main.py` exista.
2. `cp .env.example .env` (os valores padrao ja apontam para o dado sintetico de teste).
3. `docker compose up`
4. Abra `http://localhost:3000` (usuario `admin`, senha `admin`).
5. O dashboard **Restricao de Geracao (ONS)** ja aparece provisionado. Com os valores padrao das variaveis (`fonte=eolica`, `data` vazio, `usina` vazio, `api_base=http://api:8000`), ele mostra os dados sinteticos de 01 a 06/09/2026.

Se quiser ver um dia especifico do dado de teste, use `data=2026-09-03` no filtro do dashboard (o range de datas do dado sintetico e 2026-09-01 a 2026-09-06).

## Trocando o dado sintetico pelo ONS de verdade

Duas formas, sem mudar o dashboard:

**A. Rodando a API local contra o S3 do ONS.** Apague `ONS_PARQUET_DIR` do `.env` (ou deixe em branco). A API volta a ler direto do bucket publico do ONS, exatamente como no `ons.py` original.

**B. Apontando para a sua API ja publicada no Vercel.** Nao precisa nem do servico `api` deste `docker-compose` nesse caso: comente o servico `api` e, no Grafana, mude a variavel `api_base` (no topo do dashboard) para a URL do seu deploy, por exemplo `https://sua-api.vercel.app`. Como a API ja libera CORS para qualquer origem, isso funciona direto do navegador.

## O que cada painel mostra

- **Corte total no SIN / Perda (%) / Usinas com restricao / Usinas apuradas**: os quatro `stat` do topo, vindos de `total` em `/api/restricao`.
- **Maiores cortes do SIN (top 15)**: tabela vinda de `top`.
- **Usinas monitoradas**: tabela vinda de `monitoradas` (as usinas que batem com a variavel `usina`, ou com `USINAS` do `.env` da API se a variavel estiver vazia).
- **Serie semi-horaria**: grafico de linha com geracao, referencia e corte em MW ao longo do dia, vindo de `/api/serie`.

## Se algum painel nao aparecer

Isso e o unico ponto que nao pude confirmar rodando Grafana de verdade, entao vale saber resolver na mao:

1. Abra o painel, clique em **Edit**.
2. Confira se `root_selector` bate com o JSON de resposta (abra a URL da query direto no navegador para comparar).
3. Nos paineis de `stat`, se o valor nao aparecer, o mais provavel e o parser da versao do plugin tratar objeto simples (`total`) de forma diferente de array. Solucao rapida: troque `root_selector` de `total` para vazio e adicione `total.corte_mwh` (ou o campo equivalente) direto no `selector` da coluna.
4. No painel de serie temporal, se o eixo do tempo nao ficar certo, confira em **Field > instante** se o tipo esta como `Time` e o formato bate com `AAAA-MM-DD HH:mm:ss`.

Nenhum desses ajustes exige mexer no `docker-compose.yml` ou na API, so no JSON do painel pela propria interface do Grafana (que depois voce pode exportar e substituir o `restricao-ons.json`).

## Por que Infinity e nao um pipeline com banco

Os dados de restricao sao apuracao diaria, ja agregada pela sua API (nao e leitura continua de sensor). Nesse caso, consultar a API direto do Grafana e mais simples que manter uma ETL e um banco de serie temporal so para replicar o que a API ja calcula. Se um dia voce quiser historico acumulado ao longo de meses para comparar tendencia, ai sim vale escrever cada apuracao diaria num Postgres/TimescaleDB e trocar a fonte do Grafana de Infinity para Postgres, sem mudar o layout dos paineis.
