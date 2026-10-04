# Estado do projeto

Registro do que foi feito, do que está em andamento e do que falta, para retomar o trabalho a qualquer momento (outra pessoa, outra sessão de IA, ou você mesmo daqui a uma semana).

**Última atualização:** 04/10/2026, 17h33 (noite do 1º turno; totalização em andamento).

## Situação agora

- **No ar:** <https://eleicoes.code-cfernandes.com>, publicado pelo commit `4dd3061` (Portainer + Cloudflare Tunnel nomeado). Funcionando na noite real: SSE ativo, notificações push sendo enviadas.
- **Totalização real em andamento:** às 17h31, 2,48% das seções de Presidente (12.362 de 499.248) e 2,99 milhões de votos totalizados. Os testes passaram a usar o **TSE oficial** em vez do simulador.
- **Em desenvolvimento local, não commitado:** o redesign "central de acompanhamento" (ver [proposta-redesign.md](proposta-redesign.md)). Backend e mapa concluídos; design na etapa R2. **Não publicar sem revisão.**
- **Pode ser commitado agora com segurança** (nenhum agente edita): `git add README.md docs/`. O resto da árvore (`server/`, `web/`) está em edição.
- **Próximo marco:** 2º turno em **25/10/2026** (veja "Pendente para o 2º turno").

## O que está pronto e publicado

| Área | O que faz | Onde |
|---|---|---|
| Coleta do TSE | Lê os JSONs públicos de resultado; cache curto com deduplicação (1 consulta por disputa a cada `CACHE_SEGUNDOS`, independente de quantos aparelhos) | `server/tse.ts`, `server/index.ts` |
| Histórico | Cada versão do TSE gravada no SQLite; consulta hora a hora ou por atualização, incremental (`?desde=`) | `server/historico.ts`, `server/banco.ts` |
| Ao vivo | SSE por disputa: o servidor avisa versão nova (~60 bytes); o aparelho busca com ETag/304, espalhando as buscas proporcionalmente à audiência | `server/eventos.ts` |
| Desempenho | JSON e gzip prontos uma vez por versão; testado com 10 mil conexões simultâneas (p99 18 ms) | `server/index.ts` |
| Todos os cargos | Presidente (Brasil, UFs e exterior), Governador, Senador, Dep. federal, estadual, distrital | `server/config.ts` |
| Fotos oficiais | Proxy com cache em disco das fotos do TSE | `server/fotos.ts` |
| PWA e notificações | Instalável; Web Push com chaves VAPID no volume; avisos no início, a cada 25%, viradas e resultado definido; só para hosts oficiais de push | `server/notificacoes.ts`, `web/public/sw.js` |
| Telas | Início (placar nacional, seu estado, pelo país, contagem regressiva), disputa com cards e gráfico, Por estado (bandeiras, foto do líder, exterior à parte), visão do estado | `web/src/` |
| Implantação | Docker multi-stage, `compose.yaml` sem `env_file` (variáveis com padrão; Portainer cadastra as suas), `pull_policy: build` | raiz |
| Documentação | README com telas, créditos (TSE, Wikimedia, IBGE) e licença MIT | `README.md`, `LICENSE` |

## Em andamento (redesign, não commitado)

Três frentes em paralelo, cada uma dona de arquivos diferentes. Contrato de dados em `shared/tipos.ts`.

| Frente | Situação | Arquivos |
|---|---|---|
| **Backend**: `Resultado.totais`, `/api/panorama?cargo=`, linha do tempo `/api/novidades` (+ SSE `?canal=novidades`), `/api/saude` com `dados` | **Concluído, revisado e validado com o TSE oficial** (totais, Governador em 26 UFs, linha do tempo, saúde ~200 ms sem falhas). A refatoração não mudou a lógica do push (repetição determinística: avisos byte a byte iguais); migrações aditivas testadas em banco existente; eventos sem duplicata após reinício. Mudanças **intencionais** feitas depois pelo coordenador: textos dos avisos com "totalização" ("A totalização começou", "50% das seções totalizadas"), partículas minúsculas nos nomes ("André do Prado") e diferença 1º–2º na linha do tempo só a cada 1 p.p./20 min | `server/` (novo: `server/novidades.ts`) |
| **Mapa do Brasil** (malha IBGE, 17 KB gzip, escala sequencial, modo líder com legenda, teclado) | **Concluído e revisado** | `web/src/componentes/MapaBrasil.tsx`, `mapa-brasil-geo.ts` |
| **Design** (tema escuro, sidebar desktop, navegação inferior mobile, Mapa, Novidades, Mais, Status dos dados, brancos/nulos) | **R1 concluída e revisada**: indicadores do topo, Visão geral do desktop em 2 colunas (Presidente, mapa, evolução, novidades), "Seu estado" com seletor compacto, terminologia "totalização", tema escuro conferido. **Em andamento: R2** (Candidatos com abas Resultados/Evolução/Por estado; Novidades completa com filtros e ao vivo) + ajustes finos pedidos: seções exatas do TSE, 3 colunas de indicadores, sem repetir o % no card de Presidente, legenda do mapa compacto, destacar falhas só quando o TSE parar de responder. Testando com dados reais | demais arquivos de `web/` |

**Decisão aberta:** tema escuro sempre, ou seguir a preferência do aparelho (hoje segue a preferência; o escuro é a referência visual).

### Configuração recomendada ao publicar o redesign

- `MONITORAR=br:1,*:1,*:3,*:5`: a linha do tempo só registra o que o servidor coleta. Isso acrescenta ~80 disputas pequenas à coleta (custo por disputa, não por aparelho). Deputados ficam fora (arquivos grandes); seus eventos "definido" saem quando alguém abre a disputa.
- Volume estimado da linha do tempo numa noite real: ~100 a 120 eventos.

### Antes de publicar o redesign

1. As três frentes concluídas e revisadas (telas em claro e escuro, celular e desktop).
2. `npm run typecheck` e `npm run build` passando.
3. Conferir no ar uma notificação real depois do deploy (a lógica do push foi provada idêntica; só os textos mudaram de propósito).
4. Migrações do SQLite só aditivas: testar contra uma cópia do banco de produção (`data/eleicoes.db` do volume).
5. Commit, push e atualização da stack no Portainer.

## Pendente para o 2º turno (até 25/10)

| Item | Por quê |
|---|---|
| **Separar os dados por turno** no SQLite (snapshots, estado dos alertas, eventos) | Hoje tudo é chaveado por UF+cargo: o gráfico misturaria os turnos e **as notificações do 2º turno não sairiam** (o estado "resultado definido" do 1º turno continuaria valendo) |
| Cargos disponíveis por turno | No 2º turno só Presidente e Governador (e só nas UFs com 2º turno); as abas de Senado e deputados devem sumir |
| Códigos das eleições | 2º turno: federal **6258**, estadual **6260** (`ELEICAO_FEDERAL`, `ELEICAO_ESTADUAL`), `TURNO=2º turno`, `INICIO_APURACAO=2026-10-25T17:00:00-03:00` |
| Tela cara a cara | Proposta pronta (2 candidatos lado a lado, barra única com marca de 50%) |
| Seletor de turno | 1º turno vira consulta congelada (sem ao vivo nem avisos) |
| Screenshot final do README | Trocar `docs/tela-*.png` pelas telas do redesign com dados reais |

## Outras pendências e ideias

- "Governadores pelo país" (quantos eleitos no 1º turno, quantos vão ao 2º), a partir de `/api/panorama?cargo=3`.
- Borda de destaque para quem está à frente nos cards (proposta feita, não aprovada).
- Uso de IA (DeepSeek) para textos: descartado para eventos e notificações ao vivo (exatidão e neutralidade); possível para revisar frases-modelo ou um resumo pós-resultado revisado à mão.
- Cache das fotos na Cloudflare (Cache Rule para `/api/foto/*`).

## Decisões registradas

- Testes com o **TSE oficial**; simulador descartado depois que a totalização real começou.

- Termo **totalização** (soma dos boletins pelo TSE), não apuração, para o que o site mostra.
- Eventos e notificações são **estatísticos e neutros**, gerados por frases-modelo no código.
- Mapa com escala **sequencial de uma cor**, nunca semáforo; sempre com lista como alternativa.
- Percentuais de candidatos são sobre **votos válidos**; brancos, nulos e abstenção à parte, sobre o total.
- Deputados: eleição **proporcional**, ninguém é marcado como eleito pela posição.
- Celular: navegação inferior com 5 itens; desktop: sidebar recolhível.
- Nada de geolocalização; "Seu estado" é escolhido pela pessoa e fica no aparelho.

## Como retomar

```bash
npm install
cp .env.example .env
npm run dev:api     # backend (porta 3000)
npm run dev:web     # frontend com proxy
npm run typecheck
```

Para testar, use o **TSE oficial** (padrão do `.env`): entre os turnos, os resultados finais do 1º turno continuam publicados; no dia 25 o 2º turno é real. O TSE simulado usado na noite do 1º turno ficou fora do repositório (decisão do dono: não é mais necessário). Para a linha do tempo ter conteúdo localmente, rode com `MONITORAR=br:1,*:1,*:3,*:5`.

O site no ar usa o volume `dados` do Docker: **não apagar** (histórico e chaves das notificações).
