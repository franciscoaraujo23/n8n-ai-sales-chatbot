# Chatbot do site da Nautica AI

Assistente do site da [Nautica AI](https://nautica-ai-agency.com), uma agência
portuguesa de automação e IA. Responde a perguntas sobre os serviços com base
numa base de conhecimento, qualifica o visitante numa conversa consultiva e
encaminha-o para uma chamada de diagnóstico no Cal.com. Os leads ficam no
Postgres e no Notion, e a equipa é avisada no Discord.

Construído inteiro em **n8n**, com o rigor de um serviço em produção: guardas
determinísticas antes do LLM, custos controlados, erros visíveis, lógica
testada e decisões documentadas.

## O que faz

- **Responde em português de Portugal**, só com a informação da base de
  conhecimento (sem RAG: a base vai inteira no contexto, que é pequena).
- **Venda consultiva**: responde primeiro ao que foi perguntado, faz uma
  pergunta de cada vez sobre o negócio, liga a dor a um serviço, propõe a
  chamada no máximo duas vezes e diz com honestidade quando não é bom encaixe.
- **Marcação por link do Cal.com** com nome e email pré-preenchidos, montado em
  código (o modelo nunca escreve o URL).
- **Duas ferramentas**: `registar_lead` (Postgres + Notion, com verificação só
  de leitura nos CRMs dos comerciais) e `avisar_humano` (Discord, idempotente).
- **Guardas antes do LLM**: tamanho, rate limit por sessão, teto global por
  minuto e por dia, kill switch de custo diário e quarentena de prompt
  injection. Bloqueios recebem uma resposta fixa e útil, sem chamar o modelo.
- **Nunca deixa o visitante sem resposta**: se o agente falhar ou exceder o
  tempo, devolve o email e o link de marcação.
- **Tudo registado**: cada turno (texto, resposta, guarda, tools, custo
  estimado, versão da base, modelo, latência) e cada erro, com alertas no
  Discord e anti-spam.

## Estrutura

```
workflows/   exports JSON dos workflows (gerados; não editar à mão)
sql/         migrations (aplicar.sh) e sql/dev/ para desenvolvimento
prompts/     system prompt
kb/          base de conhecimento de exemplo (fictícia)
src/         guardas, validações e lógica partilhada — JavaScript puro,
             copiado para os Code nodes pelo build
scripts/     definição dos workflows em JS e build.js (gera e envia)
tests/       testes unitários (node:test) e testes SQL (PGlite)
evals/       casos em JSON, verificações e runner contra o bot real
docs/        este README, ARCHITECTURE, DECISIONS e RUNBOOK
```

## Começar

Requisitos: Node 20 ou superior. Sem dependências em runtime; o PGlite só é
usado nos testes de SQL.

```bash
npm install          # só para os testes de SQL
npm test             # gera os workflows e corre os testes unitários
npm run test:sql     # migrations num Postgres 17 em memória
npm run evals        # corre os casos contra o bot (precisa do .env)
```

Configuração local: copiar `.env.example` para `.env` e preencher. Os
segredos de produção ficam nas credenciais do n8n, nunca no repositório.

## Fazer uma alteração

1. Mudar `src/` (lógica), `prompts/` (comportamento), `scripts/workflows/`
   (estrutura dos workflows) ou `src/config.js` (limites, modelo, links).
2. `npm test` — os testes correm o código exato que vai para o n8n.
3. `node scripts/build.js --enviar <workflow>` — cria ou atualiza pelo nome,
   sempre inativo para workflows novos. Antes, fechar esse workflow no editor
   do n8n (uma gravação no editor reverte o envio).
4. Correr os evals.

Alterações ao schema: nova migration numerada em `sql/`, testada em
`tests/sql/`, aplicada na VPS com `sql/aplicar.sh` (ver o RUNBOOK).

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md) — diagramas, contrato do payload, dados,
  segurança por camada.
- [DECISIONS.md](DECISIONS.md) — cada decisão e o porquê.
- [RUNBOOK.md](RUNBOOK.md) — operar, diagnosticar e corrigir em produção.

## Estado

| | |
|---|---|
| Workflows | 9, criados e validados com o n8n-mcp |
| Testes | 90 unitários + 17 SQL |
| Evals | 10 casos iniciais |
| Base de conhecimento | ficheiro Markdown no Google Drive, lido por uma conta de serviço |
| Modelo | `anthropic/claude-haiku-5.5` via OpenRouter, escolhido por comparação de 5 modelos no eval (ver DECISIONS) |
