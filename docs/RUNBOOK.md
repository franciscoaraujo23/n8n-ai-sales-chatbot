# Runbook

Como operar, diagnosticar e corrigir o chatbot em produção.

Nos comandos SQL, `psql` quer dizer, na VPS e na pasta do `docker-compose.yml`:

```bash
docker compose exec -T postgres psql -U chatbot -d chatbot
```

## Mapa

| Workflow | ID | Precisa de estar ativo? |
|---|---|---|
| Chatbot – chat-site | `XywjB1FtsK6MGHOU` | Sim (webhook do widget) |
| Chatbot – chat-eval | `9NPGuRlkR065jBPo` | Só para correr evals |
| Chatbot – guard-trafego | `F2QZy0t2lz2OnPrI` | Sim (sub-workflow)\* |
| Chatbot – chat-core | `jgXs49EBOcyCRRmm` | Sim (sub-workflow)\* |
| Chatbot – tool-registar-lead | `LwnMitju0rWHtjzA` | Sim (sub-workflow e novas tentativas de 5 em 5 min) |
| Chatbot – tool-avisar-humano | `xA0GYSFEpnO8SqXE` | Sim (sub-workflow)\* |
| Chatbot – kb-sync | `IokQ5maWS2HHT5vd` | Sim (agendado) |
| Chatbot – manutencao | `bC7hgRgOeLyuoWtT` | Sim (agendado) |
| Chatbot – error-handler | `c0IJvGaav2ybBFB3` | Sim (sub-workflow dos ramos `[ERROR]`)\* |

\* O n8n 2.x só publica um workflow se os sub-workflows que ele chama já
estiverem publicados. Ordem: error-handler → tool-registar-lead e
tool-avisar-humano → guard-trafego → chat-core → chat-eval e chat-site.
Um envio pela API a um workflow publicado atualiza logo a versão em produção.

| Credencial no n8n | Usada em |
|---|---|
| `Postgres chatbot` | Todos |
| `OpenRouter Chatbot` | chat-core → `[AGENT] Modelo (OpenRouter)` |
| `Notion chatbot` | tool-registar-lead → procurar/gravar no "Chatbot site" |
| `Notion CRM leitura` | tool-registar-lead → procurar nos CRMs (só leitura) |
| `Discord chatbot leads` | tool-avisar-humano |
| `Discord chatbot erros` | error-handler, kb-sync |
| `Eval chatbot` | chat-eval (o mesmo valor em `EVAL_HEADER_VALUE` no `.env`) |
| `Google kb service account` | kb-sync (conta de serviço `n8n-kb@nautica-n8n.iam.gserviceaccount.com`, só leitura) |

- Widget: `https://n8n.nautica-ai-agency.com/webhook/a61384c2-724c-4657-a312-9316c5468950/chat`
  (fixo: o `webhookId` é determinístico no build).
- Evals: `https://n8n.nautica-ai-agency.com/webhook/chatbot-eval`
- Página de testes no site: `/chat-teste` (noindex, fora do sitemap).
- Os workflows estão na pasta "Chatbot" do n8n (mover à mão: a API só move
  workflows para pastas a partir do n8n 2.32).

## Pôr o bot no ar

1. Migrations aplicadas (`sql/aplicar.sh --estado` sem pendentes).
2. Base de conhecimento ativa: `SELECT origem, ativada_em FROM kb_versions WHERE ativa;`
   tem de devolver uma linha. Sem base, o bot responde só com o fallback e
   alerta (`sem_kb`).
3. Credenciais todas ligadas (o `build.js --enviar` avisa as que faltam).
4. Ativar `chat-eval` e correr `npm run evals`. Ler os resultados.
5. Ativar `tool-registar-lead`, `kb-sync`, `manutencao` e `chat-site`.
6. Testar na página `/chat-teste` do site.
7. Pôr o embed (o mesmo da página de testes) nas páginas do site.

## Desligar o bot numa emergência

- **Mais rápido:** desativar `chat-site`. O widget passa a mostrar um erro;
  retirar o embed do site logo a seguir.
- **Sem tirar o widget:** pôr `limites.custoDiarioMaxEur` a `0` em
  `src/config.js` e enviar o `chat-core`. Todas as mensagens recebem a
  resposta fixa com o email e o link de marcação, sem chamar o modelo.
- **Custo:** o limite de crédito na chave do OpenRouter é o travão duro, mesmo
  que tudo o resto falhe.

## Migrations

```bash
scp -r sql <utilizador>@<vps>:~/chatbot-sql      # a partir do repositório
# na VPS, na pasta do compose:
bash ~/chatbot-sql/aplicar.sh --estado            # o que falta
bash ~/chatbot-sql/aplicar.sh                     # aplica as pendentes
```

Cada migration corre numa transação com o registo em `schema_migrations`:
ou fica toda aplicada ou nada. Se o serviço do Postgres no compose não se
chamar `postgres`: `PG_SERVICE=<nome> bash ~/chatbot-sql/aplicar.sh`.

## Enviar workflows

```bash
npm test
node scripts/build.js --enviar                 # todos
node scripts/build.js --enviar chat-core       # só um
```

- Antes de enviar, **fechar esse workflow no editor do n8n**: um separador
  aberto grava por cima do envio se alguém carregar em guardar.
- O envio nunca ativa workflows novos. Um workflow já ativo continua ativo.
- Depois do envio, validar no n8n-mcp (`n8n_validate_workflow`).
- Nunca editar os workflows à mão no n8n: a próxima geração apaga a edição.

## Base de conhecimento

- **Fonte:** `Base_Conhecimento_Chatbot_Nautica.md` no Google Drive
  (`CONFIG.kb.driveFileId`), partilhado só com a conta de serviço, como leitor.
- **Atualizar:** no Drive, "Gerir versões → Carregar nova versão" (o ID não
  muda; um ficheiro novo teria outro ID e o `kb-sync` continuaria a ler o
  antigo). Em até 15 minutos o `kb-sync` lê-o e, se o contrato estiver
  cumprido, ativa a versão nova. Para ser já: "Execute workflow" no `kb-sync`.
- **Se mudar o ficheiro:** partilhar o novo com a conta de serviço (leitor) e
  atualizar `CONFIG.kb.driveFileId`; enviar o `kb-sync`.
- **Contrato:** os 11 títulos como "Título 2", por esta ordem: Sobre a Nautica
  · Serviços · Para quem é e para quem não é · Processo · Preços · Chamada de
  diagnóstico · Objeções e respostas · Perguntas frequentes · Credibilidade ·
  O que o bot nunca deve dizer · Contactos e horário.
- **Alerta "versão NÃO foi ativada":** o bot continua com a anterior. Corrigir
  o ficheiro conforme os erros listados no alerta.
- **Que versão está ativa:**
  ```sql
  SELECT id, left(hash, 12), origem, criado_em, ativada_em FROM kb_versions ORDER BY id DESC LIMIT 5;
  ```
- **Voltar a uma versão anterior:** repor o texto no ficheiro (o hash é o
  mesmo e a versão é reativada sem duplicar), ou em SQL:
  ```sql
  BEGIN;
  UPDATE kb_versions SET ativa = false WHERE ativa;
  UPDATE kb_versions SET ativa = true, ativada_em = now() WHERE id = <id> AND titulos_ok;
  COMMIT;
  ```
- **Base de desenvolvimento:** `sql/dev/kb_placeholder.sql` ativa a base
  fictícia (gerado pelo build).

## Mudar o modelo, os limites ou os links

Tudo em `src/config.js`. Depois: `npm test`, enviar os workflows afetados
(`chat-core` para modelo e guardas de conteúdo; `guard-trafego` para rate
limit e teto global) e correr os evals. Ao mudar de modelo, atualizar também
os preços em `config.modelo`, que servem para estimar o custo.

## Alertas no Discord (#erros)

Um alerta por workflow em cada 5 minutos; os erros entretanto ficam todos na
tabela `errors`. Detalhe: `SELECT * FROM errors WHERE id = <id>;`

| Tipo | O que quer dizer | O que fazer |
|---|---|---|
| `agente_falhou` | O modelo falhou ou excedeu o tempo; o visitante recebeu o fallback | Ver a mensagem em `errors`. Se for crédito ou chave do OpenRouter, resolver lá |
| `sem_kb` | Não há versão ativa da base | Ver "Base de conhecimento" |
| `logging_turno` / `logging_bloqueio` | Não foi possível gravar o turno; o visitante recebeu a resposta | Ver se o Postgres está em baixo ou cheio |
| `aviso_nao_enviado` | Um aviso de lead não chegou ao Discord | Ver "Leads" abaixo: o lead existe, só o aviso falhou |
| `lead_nao_sincronizado` | Um lead falhou 5 vezes a ir para o Notion | Ver `leads.sync_ultimo_erro` e reenviar (abaixo) |
| Outros (`NodeOperationError`, …) | Erro não tratado num workflow | Abrir a execução pelo link do alerta |

## Leads

```sql
-- Últimos leads e estado da sincronização
SELECT id, nome, email, telefone, sync_estado, sync_tentativas, sync_ultimo_erro, crm_existente
FROM leads ORDER BY atualizado_em DESC LIMIT 20;

-- Voltar a tentar um lead "falhado" (o agendamento apanha-o em até 5 min)
UPDATE leads SET sync_estado = 'pendente', sync_tentativas = 0, sync_proxima_em = now(), sync_ultimo_erro = NULL
WHERE id = <id>;

-- Avisos que não chegaram ao Discord
SELECT h.id, h.session_id, h.motivo, h.criado_em, h.discord_erro, l.nome, l.email, l.telefone
FROM handoffs h LEFT JOIN leads l ON l.id = h.lead_id
WHERE h.discord_estado = 'falhado' ORDER BY h.criado_em DESC;
```

Um aviso falhado não se reenvia sozinho: tratar o lead a partir da consulta
acima (ou da base "Chatbot site" no Notion).

## Consultas úteis

```sql
-- Custo estimado por dia (o real está no OpenRouter)
SELECT date(criado_em AT TIME ZONE 'Europe/Lisbon') AS dia, count(*) AS turnos,
       round(sum(custo_estimado_eur), 4) AS custo_eur
FROM turns GROUP BY 1 ORDER BY 1 DESC LIMIT 14;

-- Guardas acionadas nos últimos 7 dias
SELECT coalesce(guarda, '(passou)') AS guarda, count(*) FROM turns
WHERE criado_em > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;

-- Qualidade: fallbacks, respostas cortadas, sinais de pt-BR, links removidos
SELECT count(*) FILTER (WHERE fallback) AS fallbacks,
       count(*) FILTER (WHERE resposta_cortada) AS cortadas,
       count(*) FILTER (WHERE cardinality(pt_br) > 0) AS pt_br,
       count(*) FILTER (WHERE cardinality(links_removidos) > 0) AS links_removidos
FROM turns WHERE criado_em > now() - interval '7 days' AND guarda IS NULL;

-- Latência (ms) das respostas do agente
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latencia_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS p95
FROM turns WHERE criado_em > now() - interval '7 days' AND guarda IS NULL;

-- Uma conversa inteira
SELECT criado_em, texto, resposta, guarda, tools, cta_usada FROM turns
WHERE session_id = '<session_id>' ORDER BY criado_em;
```

## Evals

```bash
npm run evals                         # todos os casos
node evals/correr.js faq-servicos     # só um
```

- Precisa do `chat-eval` ativo e do `.env` preenchido.
- Os resultados ficam em `evals/resultados/` (fora do git), com cada resposta
  completa. As verificações automáticas não dispensam lê-las.
- Os evals passam pelo kill switch de custo, como produção.
- **Efeitos reais (decisão: opção B):** o caso de qualificação cria um lead no
  Postgres, uma página no "Chatbot site" e um aviso no Discord. Limpar depois:
  ```sql
  DELETE FROM handoffs WHERE session_id IN (SELECT session_id FROM leads WHERE email LIKE '%@exemplo.pt');
  DELETE FROM leads WHERE email LIKE '%@exemplo.pt';
  ```
  No Notion, apagar as páginas com email `@exemplo.pt`.

## Pedido de acesso ou apagamento de dados (RGPD)

```sql
-- Encontrar as conversas da pessoa
SELECT session_id FROM leads WHERE email = '<email>' OR telefone = '<+351…>';

-- Apagar (substituir <session_id>)
BEGIN;
DELETE FROM handoffs WHERE session_id = '<session_id>';
DELETE FROM leads WHERE session_id = '<session_id>';
DELETE FROM turns WHERE session_id = '<session_id>';
DELETE FROM chat_memoria WHERE session_id = '<session_id>';
COMMIT;
```

Apagar também a página no "Chatbot site" (Notion) e a mensagem no Discord.
As execuções bem-sucedidas não ficam gravadas no n8n; as com erro podem
conter texto da conversa e são apagadas pela retenção do n8n.

## Rodar a chave da conta de serviço (kb-sync)

1. Google Cloud → IAM → Contas de serviço → `n8n-kb` → Chaves → criar uma
   chave JSON nova.
2. Colar o email e a chave privada na credencial `Google kb service account`.
3. "Execute workflow" no `kb-sync` para confirmar.
4. Apagar a chave antiga no Google Cloud.

Se a chave vazar: apagá-la logo no Google Cloud. Só dava leitura a este
ficheiro.

## Rodar o token dos evals

1. Gerar: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Pôr o valor novo na credencial `Eval chatbot` e em `EVAL_HEADER_VALUE` no `.env`.
3. Nunca no `.env.example`: esse vai para o git.
