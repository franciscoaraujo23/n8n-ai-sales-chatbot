# Runbook

How to operate, diagnose and fix the agent in production.

In the SQL commands below, `psql` means, on the VPS, in the folder with
`docker-compose.yml`:

```bash
docker compose exec -T postgres psql -U chatbot -d chatbot
```

## Map

| Workflow | Must be active? |
|---|---|
| Chatbot – chat-site | Yes (widget webhook) |
| Chatbot – chat-eval | Only to run evals |
| Chatbot – guard-trafego | Yes (sub-workflow)\* |
| Chatbot – chat-core | Yes (sub-workflow)\* |
| Chatbot – tool-registar-lead | Yes (sub-workflow and 5-minute retries) |
| Chatbot – tool-avisar-humano | Yes (sub-workflow)\* |
| Chatbot – kb-sync | Yes (scheduled) |
| Chatbot – manutencao | Yes (scheduled) |
| Chatbot – error-handler | Yes (sub-workflow of the `[ERROR]` branches)\* |

\* n8n 2.x only publishes a workflow if the sub-workflows it calls are
already published. Order: error-handler → tool-registar-lead and
tool-avisar-humano → guard-trafego → chat-core → chat-eval and chat-site.
Updating a published workflow through the API updates production
immediately.

| n8n credential | Used by |
|---|---|
| `Postgres chatbot` | All |
| `OpenRouter Chatbot` | chat-core → `[AGENT] Modelo (OpenRouter)` |
| `Notion chatbot` | tool-registar-lead → read/write the "Chatbot site" database |
| `Notion CRM leitura` | tool-registar-lead → search the sales CRMs (read-only) |
| `Discord chatbot leads` | tool-avisar-humano |
| `Discord chatbot erros` | error-handler, kb-sync |
| `Eval chatbot` | chat-eval (same value as `EVAL_HEADER_VALUE` in `.env`) |
| `Google kb service account` | kb-sync (service account, read-only access to the knowledge base file) |

- Widget: `https://<n8n-host>/webhook/<webhookId>/chat` (stable: the
  `webhookId` is deterministic in the build).
- Evals: `https://<n8n-host>/webhook/chatbot-eval` (header auth).
- Test page on the website: `/chat-teste` (noindex, not in the sitemap).

## Launch checklist

Ordering rules: **a new migration is applied before deploying the workflows
that depend on it**, and **`manutencao` must be active before `chat-site` is
published**: without it there's no `rate_limits` cleanup or 12-month
retention, and the counters table grows with every message.

**Data and configuration**
- [ ] `sql/aplicar.sh --estado` shows nothing pending.
- [ ] Real knowledge base active: `SELECT origem, left(hash,12), ativada_em FROM kb_versions WHERE ativa;`
      returns one row whose `origem` is the Drive file id (not `placeholder`).
- [ ] All credentials connected (`node scripts/build.js --enviar` with no missing-credential warnings).
- [ ] Credit limit on the OpenRouter key above the sum of the estimated kill
      switches (`custoDiarioMaxEur`: website €1, eval €0.60).

**Workflows published, in this order**
- [ ] error-handler
- [ ] tool-avisar-humano and tool-registar-lead
- [ ] guard-trafego
- [ ] chat-core
- [ ] kb-sync
- [ ] **manutencao** (before chat-site)
- [ ] chat-eval (evals only)
- [ ] chat-site (last)

**Quality**
- [ ] `npm run test:tudo` passes.
- [ ] `npm run evals` (5 runs per case) read case by case; no critical case
      (injection, pricing, never-say, qualification) below 100%.

**Live acceptance test** (with an `@exemplo.pt` email, which stays in Postgres only)
- [ ] Message through `chat-site` (`/chat-teste` page): reply in `{ output }`, website CORS.
- [ ] Per-session rate limit: more than 6 messages in a minute → fixed reply, turn with `guarda = limite_sessao`.
- [ ] 3 quarantines in one session → `sessao_bloqueada`.
- [ ] Kill switch: lower `custoDiarioMaxEur.site` temporarily → fixed reply without the LLM; restore.
- [ ] Request for a human → `pede_humano` notification on Discord #leads.
- [ ] Real test lead with contact details (domain outside the test list, delete afterwards):
      page in "Chatbot site", automatic `lead_qualificado` notification, correct CRM check.
- [ ] A handled error reaches #errors (e.g. temporarily invalid Notion credential → lead `pendente`, retry, alert).

**Website**
- [ ] Privacy policy updated and published.
- [ ] Widget on the intended pages.
- [ ] Test data cleaned up (see "Evals").

## Emergency shutdown

- **Fastest:** deactivate `chat-site`. The widget shows an error; remove the
  embed from the website right after.
- **Keeping the widget:** set `limites.custoDiarioMaxEur.site` to `0` in
  `src/config.js` and deploy `chat-core`. Every message gets the fixed reply
  with the email and booking link, without calling the model.
- **Cost:** the credit limit on the OpenRouter key is the hard stop, even if
  everything else fails.

## Migrations

```bash
scp -r sql <user>@<vps>:~/chatbot-sql             # from the repository
# on the VPS, in the compose folder:
bash ~/chatbot-sql/aplicar.sh --estado            # what's pending
bash ~/chatbot-sql/aplicar.sh                     # apply pending migrations
```

Each migration runs in one transaction together with its `schema_migrations`
record: either all of it is applied or nothing is. If the Postgres service in
the compose file isn't called `postgres`:
`PG_SERVICE=<name> bash ~/chatbot-sql/aplicar.sh`.

## Deploying workflows

```bash
npm test
node scripts/build.js --enviar                 # all
node scripts/build.js --enviar chat-core       # just one
```

- Before deploying, **close that workflow in the n8n editor**: an open tab
  overwrites the deployment if someone hits save.
- Deploying never activates new workflows. An active workflow stays active.
- After deploying, validate with n8n-mcp (`n8n_validate_workflow`).
- Never edit the workflows by hand in n8n: the next build overwrites the
  edit.

## Knowledge base

- **Source:** a Markdown file in Google Drive (`CONFIG.kb.driveFileId`),
  shared only with the service account, as a viewer.
- **Updating:** in Drive, "Manage versions → Upload new version" (the file id
  stays the same; a new file would have a different id and `kb-sync` would
  keep reading the old one). Within 15 minutes `kb-sync` picks it up and, if
  the contract is met, activates the new version. To do it now: "Execute
  workflow" on `kb-sync`. To edit outside Drive: download the file, edit it in
  a text editor and upload it as a new version. "Open with → Google Docs"
  creates a copy with a different id, and so does uploading a separate file:
  in both cases the agent won't see the change.
- **Switching files:** share the new file with the service account (viewer),
  update `CONFIG.kb.driveFileId`, deploy `kb-sync`.
- **Contract:** the 11 section headings (`## …`), in this order: Sobre a
  Nautica · Serviços · Para quem é e para quem não é · Processo · Preços ·
  Chamada de diagnóstico · Objeções e respostas · Perguntas frequentes ·
  Credibilidade · O que o bot nunca deve dizer · Contactos e horário.
- **"Version NOT activated" alert:** the agent keeps the previous one. Fix the
  file according to the errors listed in the alert.
- **Which version is active:**
  ```sql
  SELECT id, left(hash, 12), origem, criado_em, ativada_em FROM kb_versions ORDER BY id DESC LIMIT 5;
  ```
- **Rolling back:** restore the old text in the file (same hash, so that
  version is reactivated without a duplicate), or in SQL:
  ```sql
  BEGIN;
  UPDATE kb_versions SET ativa = false WHERE ativa;
  UPDATE kb_versions SET ativa = true, ativada_em = now() WHERE id = <id> AND titulos_ok;
  COMMIT;
  ```
- **Development knowledge base:** `sql/dev/kb_placeholder.sql` activates the
  fictional one (generated by the build).

## Changing the model, limits or links

All in `src/config.js`. Then: `npm test`, deploy the affected workflows
(`chat-core` for the model and content guards; `guard-trafego` for rate
limits and the global cap) and run the evals. When switching models, also
update the prices in `config.modelo`, which drive the cost estimate. Not every
model works with n8n's agent: if the battery shows fallback replies, the model
fails inside the agent (see `agente_falhou` in `errors`) and isn't usable,
however good it is outside n8n.

## Discord alerts (#errors)

One alert per workflow every 5 minutes; every error in between is still
recorded in the `errors` table. Details: `SELECT * FROM errors WHERE id = <id>;`

Alerts go out through the `Discord chatbot erros` credential and lead
notifications through `Discord chatbot leads`. If an error alert shows up in
the leads channel (or the other way round), the webhook URLs are swapped in
the credentials: fix it in n8n, not in the workflows.

| Type | Meaning | What to do |
|---|---|---|
| `agente_falhou` | The model failed or timed out; the visitor got the fallback | Check the message in `errors`. If it's OpenRouter credit or the key, fix it there |
| `sem_kb` | No active knowledge-base version | See "Knowledge base" |
| `logging_turno` / `logging_bloqueio` | A turn couldn't be stored; the visitor still got the reply | Check whether Postgres is down or full |
| `aviso_nao_enviado` | A lead notification didn't reach Discord | See "Leads": the lead exists, only the notification failed |
| `lead_nao_sincronizado` | A lead failed to reach Notion 5 times | Check `leads.sync_ultimo_erro` and retry (below) |
| Others (`NodeOperationError`, …) | Unhandled error in a workflow | Open the execution from the alert's link |

## Leads

```sql
-- Latest leads and sync state
SELECT id, nome, email, telefone, sync_estado, sync_tentativas, sync_ultimo_erro, crm_existente
FROM leads ORDER BY atualizado_em DESC LIMIT 20;

-- Retry a "failed" lead (the schedule picks it up within 5 min)
UPDATE leads SET sync_estado = 'pendente', sync_tentativas = 0, sync_proxima_em = now(), sync_ultimo_erro = NULL
WHERE id = <id>;

-- Notifications that didn't reach Discord
SELECT h.id, h.session_id, h.motivo, h.criado_em, h.discord_erro, l.nome, l.email, l.telefone
FROM handoffs h LEFT JOIN leads l ON l.id = h.lead_id
WHERE h.discord_estado = 'falhado' ORDER BY h.criado_em DESC;
```

A failed notification isn't resent automatically: follow up on the lead from
the query above (or from the "Chatbot site" database in Notion).

## Useful queries

```sql
-- Estimated cost per day (the real figure is in OpenRouter)
SELECT date(criado_em AT TIME ZONE 'Europe/Lisbon') AS dia, count(*) AS turnos,
       round(sum(custo_estimado_eur), 4) AS custo_eur
FROM turns GROUP BY 1 ORDER BY 1 DESC LIMIT 14;

-- Guards triggered in the last 7 days
SELECT coalesce(guarda, '(passou)') AS guarda, count(*) FROM turns
WHERE criado_em > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;

-- Quality: fallbacks, truncated replies, pt-BR signals, removed links
SELECT count(*) FILTER (WHERE fallback) AS fallbacks,
       count(*) FILTER (WHERE resposta_cortada) AS cortadas,
       count(*) FILTER (WHERE cardinality(pt_br) > 0) AS pt_br,
       count(*) FILTER (WHERE cardinality(links_removidos) > 0) AS links_removidos
FROM turns WHERE criado_em > now() - interval '7 days' AND guarda IS NULL;

-- Latency (ms) of agent replies
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latencia_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS p95
FROM turns WHERE criado_em > now() - interval '7 days' AND guarda IS NULL;

-- A whole conversation
SELECT criado_em, texto, resposta, guarda, tools, cta_usada FROM turns
WHERE session_id = '<session_id>' ORDER BY criado_em;
```

## Evals

```bash
npm run evals                                   # every case, 5 runs each
node evals/correr.js faq-servicos               # just one
node evals/correr.js --repeticoes 3             # a different number of runs
node evals/correr.js --reavaliar evals/resultados/<file>.json
                                                # current checks on recorded replies
```

- Requires `chat-eval` to be active and `.env` to be filled in.
- Each case's result is its **pass rate over N runs** (replies vary). To
  compare before and after a fix, re-score the old run with `--reavaliar` so
  both use the same checks.
- Results go to `evals/resultados/` (not in git), with every full reply. The
  automated checks don't replace reading them.
- Evals go through the cost kill switch like production, with their own
  budget (`custoDiarioMaxEur.eval`, €0.60/day): a full battery costs about
  €0.10–0.15. Once it's used up, eval replies come back with
  `guarda = kill_switch_custo` and the website isn't affected.
- **No real side effects:** cases that create leads use `@exemplo.pt`
  emails, a test domain (`CONFIG.leadsTeste.dominios`): the lead stays in
  Postgres with `sync_estado = 'teste'`, with no Notion or Discord. Clean up
  every now and then:
  ```sql
  DELETE FROM handoffs WHERE session_id IN (SELECT session_id FROM leads WHERE sync_estado = 'teste');
  DELETE FROM leads WHERE sync_estado = 'teste';
  ```

## Data access or deletion requests (GDPR)

```sql
-- Find the person's conversations
SELECT session_id FROM leads WHERE email = '<email>' OR telefone = '<+351…>';

-- Delete (replace <session_id>)
BEGIN;
DELETE FROM handoffs WHERE session_id = '<session_id>';
DELETE FROM leads WHERE session_id = '<session_id>';
DELETE FROM turns WHERE session_id = '<session_id>';
DELETE FROM chat_memoria WHERE session_id = '<session_id>';
COMMIT;
```

Also delete the page in "Chatbot site" (Notion) and the Discord message.
Successful executions aren't stored in n8n; failed ones may contain
conversation text and are removed by n8n's own retention.

## Rotating the service account key (kb-sync)

1. Google Cloud → IAM → Service accounts → the kb-sync account → Keys →
   create a new JSON key.
2. Paste the email and private key into the `Google kb service account`
   credential.
3. "Execute workflow" on `kb-sync` to confirm.
4. Delete the old key in Google Cloud.

If the key ever leaks: delete it in Google Cloud right away. It only grants
read access to this one file.

## Rotating the eval token

1. Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Put the new value in the `Eval chatbot` credential and in
   `EVAL_HEADER_VALUE` in `.env`.
3. Never in `.env.example`: that file goes to git.
