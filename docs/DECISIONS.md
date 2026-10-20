# Decision log

Every decision and the reason behind it. Decisions that changed carry the
date and why. Facts about n8n marked "verified" were confirmed in the source
code of the version running in production (2.29), not in the docs.

## Architecture

- **Everything on n8n, no RAG.** The knowledge base is small and fits
  entirely in the context. Fewer moving parts, more consistent answers, and
  the knowledge base is a file in Google Drive that non-developers can edit.
- **One adapter per channel + a core (`chat-core`).** The core receives a
  canonical, versioned payload (`schema_version: 1`) and doesn't know which
  channel a message came from; a test makes sure no core Code node branches
  on the channel. Adding WhatsApp means writing one more adapter.
- **Traffic guards in a sub-workflow (`guard-trafego`)**, called by every
  public adapter. The eval adapter doesn't call it. There's no "skip limits"
  flag in the core: it would be an open door.
- **Content guards and the cost kill switch live in the core**, so they run
  on every channel, evals included: the agent being tested is the agent in
  production, and evals cost money too.
- **The global cap is the real protection.** The `session_id` is generated
  on the client and can be rotated; the global cap covers all public
  channels together.
- **The Chat Trigger doesn't expose the IP or the headers** (verified: the
  node passes only the request body to the workflow). An IP limit would have
  to live in Caddy.
- **No per-IP limit in v1.** It would require building Caddy with a plugin
  for traffic that doesn't exist yet. Revisit if the `rate_limits` table
  shows real abuse.
- **Allowed Origins is CORS only** (verified): it sets the response header,
  it doesn't reject requests. One more reason the global cap is what counts.
- **Files are rejected during normalization.** In Embedded mode the Chat
  Trigger accepts `multipart/form-data` with files even with uploads turned
  off in the widget (verified: that option only applies to n8n's hosted
  chat).
- **Traffic blocks are logged by `guard-trafego` itself**: it's the only
  piece that sees them, since the core never runs.

## Agent behavior

- **Consultative selling written as rules in the prompt**
  (`prompts/system.md`): answer first, one question at a time, tie the pain
  to a service, be honest about fit, no fake urgency or discounts, never
  invent beyond the knowledge base.
- **Booking in the Cal.com calendar, opened on top of the chat**
  (2026-10-19), with name and email pre-filled. It started as a link opening
  in a new tab while the widget was `@n8n/chat`; with the custom widget the
  link opens Cal.com's modal (the same integration and theme as the website's
  booking page) and the booking is confirmed in the conversation. Without the
  Cal.com script, the link opens in a new tab.
- **The link is built in code, not by the LLM.** The agent writes
  `[[MARCAR]]`; post-processing swaps it for the URL with the data stored in
  that same turn. That guarantees the right URL and enforces the proposal
  limit in code too. If the agent writes its own Cal.com link with custom
  text, the text is kept so the sentence still reads well.
- **At most two calls to action per conversation, on the agent's own
  initiative** (2026-10-20). Visitor requests don't count: when the message
  asks for the booking or the link, or the visitor has just shared their
  email, the link always goes through (`ctaPedida`, the same function in
  post-processing and in the evals). This came from a real test where the
  visitor asked to book after both proposals had been used. Not nagging still
  holds.
- **Link allowlist in replies** (the website and Náutica's calendar). The
  widget escapes HTML and only turns Markdown links to allowed hosts into
  links (the same allowlist, enforced again on the client), so the only
  useful link is one the code built or let through.
- **`avisar_humano`'s `motivo` is a closed enum.** With free text, the
  idempotency rule "don't notify twice unless the reason changes" can't work.
- **A lead with contact details notifies the team automatically**
  (2026-10-18). The agent's business goal is getting a lead with contact
  details to the team, and that shouldn't depend on the model remembering a
  second tool call. `tool-registar-lead` sends the notification itself
  (`lead_qualificado`) after syncing, so it already carries the Notion link
  and the CRM check.
- **`lead_qualificado` is reserved for the automatic notification.** If the
  agent asks for it, it becomes `outro`: a premature notification, without
  contact details, would take the (conversation, reason) slot and block the
  automatic one.
- **The team notification is sent ~10 s later, off the tool's path**
  (2026-10-19). A visitor who asks for a human and leaves their email in the
  same message makes the agent call `avisar_humano` and `registar_lead` in
  the same step, and n8n runs the first to completion before the second
  (measured: the handoff was written ~0.4 s before the lead). Read
  immediately, the handoff showed "no contact yet" and test leads reached
  Discord. The tool now only records and replies; the workflow calls itself
  without waiting, pauses 10 s, re-reads the handoff and the lead, and then
  sends (or flags it as a test). This replaced an earlier in-tool wait
  (2026-10-18) that assumed parallel execution. A 10-second delay makes no
  difference to a contact request.
- **Objections answered the way the knowledge base says**, talking about
  what the company offers rather than what it doesn't have yet. A question
  about clients gets the "you're new" objection's answer (trial month, no
  setup fee, pay at the end of each month), told positively. The prompt
  avoids spelling out the phrases to avoid: naming them made the model more
  likely to use them.
- **Tools get the `session_id` from the context, never from the LLM**: the
  model can't write data into another conversation.
- **Without an active knowledge base, the agent isn't called** (reason
  `sem_kb`): without one, it would make things up. The visitor gets the
  fallback and the team gets an alert.
- **No consent prompt in the chat** (2026-10-17). Someone who shares their
  contact details wants to be contacted: the legal basis is responding to the
  person's own request (pre-contractual steps under the GDPR). The chat shows
  a line linking to the privacy policy, and the policy covers the chatbot.
- **The brand is written "Náutica AI"**, in the prompt, fixed replies and
  post-processing (which corrects the unaccented form outside URLs and
  emails).

## Model and cost

- **The model is configured in one place** (`src/config.js`). An interim,
  inexpensive model until the evals; the final choice is an eval criterion,
  not a hunch.
- **`anthropic/claude-haiku-5.5`** (2026-10-18). Five inexpensive candidates
  with tool support on OpenRouter, the same battery (12 cases × 5 runs)
  through `chat-eval`, meaning the n8n agent exactly as it runs in
  production, all re-scored with the same checks:

  | Model | USD per 1M tokens (in / out) | Passing runs | Fallbacks | Latency p50 / p90 |
  |---|---|---|---|---|
  | `claude-haiku-5.5` | 0.10 / 0.50 | 58/60 | 0 | 3.5 s / 4.4 s |
  | `gemini-3.1-flash-lite` | 0.25 / 1.50 | 58/60 | 0 | 1.5 s / 2.1 s |
  | `gpt-4.1-mini` (interim) | 0.40 / 1.60 | 55/60 | 0 | 1.6 s / 2.4 s |
  | `gpt-5.6-luna` | 0.20 / 1.20 | 41/60 | 19 of 85 | — |
  | `mistral-small-2603` | 0.15 / 0.60 | 5/60 | 72 of 85 | — |

  The Haiku/Gemini tie was decided by the kind of failure. Gemini said "I've
  noted that" and "I've added your email" without calling `registar_lead`,
  and in one of 5 conversations the lead was lost: the worst possible failure
  for an agent whose job is getting leads to the team. Haiku registered the
  lead in all 5 conversations and is also the cheapest. The trade-off is
  about 2 s more latency, fine in a chat with a typing indicator. Luna and
  Mistral fail inside the n8n agent (fallback replies), so their quality
  wasn't scored; DeepSeek was excluded because it stores data in China.
  Revisit if latency starts hurting conversion or prices change.
- **Output limit of 2,000 tokens** (2026-10-19). Haiku 5.5 reasons before
  answering, and the reasoning counts against the output limit; at 700
  tokens, part of the replies came back truncated or empty. The visible
  length is still capped in post-processing (`respostaMaxChars`).
- **Prompt caching as a model criterion.** The system message is prompt +
  knowledge base (stable) + conversation state (at the end), so the stable
  prefix benefits from automatic caching where providers offer it. Anthropic
  models on OpenRouter need explicit `cache_control`, which n8n's node doesn't
  send; Haiku is still the cheapest without it.
- **Estimated cost, not measured.** n8n's AI Agent doesn't pass token usage
  to later nodes. The estimate (~4 characters per token) includes the extra
  model round-trips when the agent uses tools, since each one resends the
  whole context.
- **Two cost brakes:** the daily kill switch in the core (estimated; spending
  above it at this traffic level is almost certainly abuse or a bug) and the
  credit limit on the OpenRouter key itself (real).
- **One budget per channel** (2026-10-18): website €1/day, evals €0.60/day,
  each counting only its own spend. A long day of model comparisons would
  otherwise have used up a shared budget and closed the website chat until
  midnight. The cap is looked up per channel in the config, not decided by
  an `if` in the core, which still never branches on the channel; a channel
  without a budget is closed. The total (~$1.75) stays under the key's
  $2/day limit.
- **Memory with `contextWindowLength` = 6**: the node counts interactions
  (question + answer), not messages; 6 interactions are the 12 messages I
  decided on.

## Widget

- **A custom widget instead of `@n8n/chat`** (2026-10-19). Two files in the
  website repository, no dependencies, using the website's design tokens. The
  generic widget couldn't open the calendar on top of the chat or carry the
  brand, and pulled a dependency from a CDN.
- **State in `sessionStorage`, not `localStorage` or cookies**: the
  conversation carries over between pages and is cleared when the tab
  closes, like the rest of the site (the visit-source tracking works the same
  way).
- **The character is inline SVG, not an image.** It stays sharp at any size,
  weighs ~6 KB and can animate (eyes, wave, talking mouth). A pre-rendered 3D
  image would be static, and a 3D model in the browser would cost 150–600 KB.
- **Continuous animations only during the first 20 seconds** (2026-10-21).
  Measured with Chrome traces: the character was the effect repainting the
  most, underneath the site's film-grain overlay. Afterwards, only the blink
  and the occasional wave remain.
- **No avatar next to each reply.** The panel is narrow (390 px) and the
  header already shows the character; the gain didn't justify the width
  taken from every message.

## Data

- **Migrations live in the repository and are applied over SSH** with
  `sql/aplicar.sh`. Postgres isn't exposed, by design.
- **The memory table (`chat_memoria`) is created by n8n's Postgres Chat
  Memory node**, not by a migration: the node expects a specific schema, and
  replicating it by hand invites subtle failures.
- **Stateful logic in atomic SQL functions**, tested on PGlite (in-memory
  Postgres 17): counters, knowledge-base activation, handoff idempotency, sync
  reservations, alert anti-spam. Workflows call them with a single `jsonb`
  parameter, so commas and nulls can never break a query.
- **Notion sync is coordinated in Postgres.** A time-limited reservation
  keeps the tool and the scheduled retry from handling the same lead at the
  same time (which would create two pages). If the data changes during a
  sync, the lead goes back to pending instead of losing the change. Backoff
  of 5 min, 30 min, 2 h and 12 h; on the fifth failure, "failed" and an
  alert.
- **Sync retries live in `tool-registar-lead`**, as a second trigger
  (5-minute schedule), not in a workflow of their own (2026-10-18). There's a
  single sync chain for the tool and the retries, and the Postgres
  reservation already keeps them from colliding. Splitting them would mean
  duplicating the chain or adding a third sub-workflow, with no reduction in
  risk.
- **`atualizado_em` only changes with the lead's data**, not with sync
  attempts: the date of the last contact is what retention is based on.
- **No stored successful executions** in any of the agent's workflows: they
  contain visitor text and personal data. Errors are still stored; what's
  needed from each turn goes to the `turns` table.
- **The knowledge base is read by a Google service account**, not OAuth
  (2026-10-18). Three reasons: access to this one document only (the file is
  shared with the service account as a viewer, and with no one else);
  read-only (scope `drive.readonly`, allowed domain `www.googleapis.com`
  only); and no token expiry (OAuth depends on a person's login, and with
  the app in testing mode Google expires the token after 7 days). The cost is
  a long-lived private key in n8n, rotated manually (RUNBOOK).
- **The knowledge base is a `.md` file in Drive, not a Google Doc.**
  `kb-sync` downloads it as is; if it ever becomes a Google Doc, it exports
  it as Markdown with no other change. It's updated with "Manage versions →
  Upload new version", so the file id never changes.
- **Every knowledge-base version is validated against a contract** (the
  required sections) and identified by a hash of the normalized text. An
  invalid version is never activated and triggers an alert; re-uploading an
  earlier text reactivates that version without duplicating it.
- **12-month retention** (matching the privacy policy), cleaned up daily by
  `limpar_dados_antigos()`; errors, 3 months.

## Notion

- **A dedicated "Chatbot site" database inside "CRM Clientes"**, separate
  from the sales team's CRM. The agent never writes to the sales CRMs.
- **A read-only check against two CRMs**, through a Notion integration that
  only has read permission: the rule doesn't depend on discipline. It costs 2
  requests per lead (far from the ~3/s limit) and avoids contacting twice
  someone the sales team is already working with.
- **Notion API calls through HTTP Request** (version 2022-06-28) instead of
  the Notion node: full control over the "email OR phone" filter and the
  PATCH/POST.
- **Phone numbers compared on their last 9 digits.** The CRMs store them in
  several formats ("912345678", "+351912345678", …).
- **Only fields with a value are sent**, and source/status only on creation:
  the agent never erases what the team wrote by hand or changes a lead's
  status.

## Errors

- **One error handler with two entry points**: the Error Trigger (unhandled
  errors from every workflow) and a direct call for HANDLED errors, where the
  visitor still gets a useful reply but the team needs to know: failing to
  log a turn, an agent failure, a missing knowledge base, a notification
  Discord rejected, a lead that gave up syncing.
- **Handled-error reports go inline, without waiting.** A sub-workflow
  returns the output of its last executed node; a parallel branch could end
  last and replace the reply. An Execute Workflow call without waiting
  returns the item it received (verified), so the main flow carries on with
  the same data.
- **Logging never breaks the reply** (`continueErrorOutput`), and a logging
  failure counts as an error for the error handler.
- **Anti-spam per workflow (5 minutes)**, decided in SQL with a lock; the
  alert flag is cleared if Discord fails, so the next error tries again.
- **Alerts never include the error message**, which may contain visitor
  text; it stays in Postgres only. Handled errors carry no execution link
  (successful executions aren't stored).
- **Discord messages without mentions**: visitor text containing
  "@everyone" doesn't ping the channel.

## Engineering

- **Workflows defined in JavaScript** (`scripts/workflows/`) and generated by
  `scripts/build.js`. Code-node code comes from `/src`, tested. The exports
  in `/workflows` carry no credential or workflow ids: they're resolved by
  name at deploy time (case-insensitive).
- **The generated Code nodes are tested too** (`tests/harness.js`), against a
  mock of `$`, `$json` and `$input`: swapped node names and missing fields
  are caught before they reach n8n.
- **Deterministic node and webhook ids.** The widget's URL doesn't change
  between deployments, and exports only change when their content does.
- **No `URL` in Code nodes.** n8n 2.29's sandboxed Code nodes don't have the
  global `URL` object (found in the first live test). The code in `/src`
  parses URLs by hand, and the test harness runs Code nodes without `URL` or
  `URLSearchParams`.
- **Sub-workflows are published before their callers.** n8n 2.x refuses to
  publish a workflow that references unpublished sub-workflows. Updating a
  published workflow through the API updates production immediately.
- **New workflows are always deployed inactive**; validated with n8n-mcp
  before and after every deployment.
- **The repository uses LF** (`.gitattributes`): `aplicar.sh` runs on the
  VPS's Linux and breaks with CRLF.

## Evals

- **A dedicated adapter (`chat-eval`) with header auth**, calling the core
  without `guard-trafego`. With n8n's test webhook the editor would have to
  be listening, and the traffic limits would block the eval itself.
- **Deterministic checks, not an LLM judge**: guard, tools, call to action,
  pt-BR, prices outside the knowledge base, prompt leaks. Selling quality is
  read from the recorded results.
- **Each case runs 5 times and reports a pass rate** (2026-10-18). Model
  output varies from run to run; with a single run, a before/after comparison
  can improve or regress by luck. `--reavaliar` applies the current checks to
  recorded replies, to compare under the same rules without calling the
  agent again.
- **Read the failures before changing the agent.** A failure can be a correct
  paraphrase a regex doesn't match. Fix the check and re-score first; only
  then change the agent.
- **Test leads with no real side effects** (2026-10-18). Leads whose final
  email uses a test domain (`CONFIG.leadsTeste`) stay in Postgres only
  (`sync_estado = 'teste'`): no Notion, no Discord, no retries. Their handoffs
  are flagged as tests too. The rule looks at the data, not the channel, so it
  also covers visitors who type example addresses.
- **A battery of 12 attacks** (2026-10-21) runs with the rest of the evals:
  multi-turn role changes, translation and role-play leaks, fake system
  blocks, false authority, phishing links, other visitors' data, malicious
  code, HTML and mass mentions in lead fields. See [SECURITY.md](SECURITY.md).
