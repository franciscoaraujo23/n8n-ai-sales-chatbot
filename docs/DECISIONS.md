# Decisões

> Rascunho, completado no passo 7. Cada decisão tem o porquê; as que
> mudaram têm a data e o motivo da mudança.

## Arquitetura

- **Tudo em n8n, sem RAG.** A base de conhecimento é pequena e vai inteira
  no contexto. Menos peças, respostas mais consistentes.
- **Adaptador por canal + núcleo (`chat-core`).** O núcleo recebe um payload
  canónico versionado e não sabe de que canal veio a mensagem. Ligar o
  WhatsApp é escrever outro adaptador.
- **Guardas de tráfego num sub-workflow (`guard-trafego`)**, chamado por cada
  adaptador público. O adaptador de eval não o chama. Não há nenhuma flag de
  "saltar limites" no núcleo: seria uma porta aberta.
- **Guardas de conteúdo e kill switch de custo no núcleo**, para correrem em
  todos os canais, incluindo os evals (testa-se o mesmo bot que está em
  produção, e os evals também gastam dinheiro).
- **Teto global como proteção real.** O `session_id` é gerado no cliente e
  pode ser rodado; o teto global junta todos os canais públicos.
- **O Chat Trigger não expõe o IP nem os cabeçalhos** (verificado no código
  do n8n 2.29.10: o nó passa ao workflow só o corpo do pedido). Limitar por
  IP teria de ser no Caddy.
- **Allowed Origins é só CORS**: define o cabeçalho da resposta, não recusa
  pedidos. Um `curl` com qualquer origem é processado. Mais uma razão para o
  teto global ser a proteção real.
- **Ficheiros recusados na normalização.** Em modo Embedded, o Chat Trigger
  aceita `multipart/form-data` com ficheiros mesmo com uploads desligados no
  widget (a opção só se aplica ao chat alojado pelo n8n).
- **Sem limite por IP na v1.** Obrigaria a compilar o Caddy com um plugin,
  para um tráfego que ainda não existe. Revisitar se aparecer abuso real na
  tabela `rate_limits`.

## Dados

- **Migrations escritas no repositório, aplicadas por SSH** com
  `sql/aplicar.sh`. O Postgres não está exposto, e ainda bem.
- **A tabela da memória (`chat_memoria`) é criada pelo nó Postgres Chat
  Memory**, não pela migration: o nó espera um schema concreto e replicá-lo
  à mão arrisca falhas pouco óbvias.
- **Lógica de contadores, ativação da KB, idempotência e anti-spam em funções
  SQL**, atómicas e testadas (PGlite), em vez de várias queries no n8n.
- **Sem gravação de execuções bem-sucedidas** no `chat-site`, `chat-core` e
  nas tools: contêm texto e dados pessoais dos visitantes. Os erros continuam
  a ser gravados; o que é preciso de cada turno fica na tabela `turns`.
- **Sincronização com o Notion controlada no Postgres** (`002_sync_leads.sql`).
  Uma reserva com prazo impede que a tool e a nova tentativa agendada tratem
  o mesmo lead ao mesmo tempo (o que criaria duas páginas). Se os dados mudam
  durante a sincronização, o lead volta a pendente em vez de as alterações se
  perderem. Backoff de 5 min, 30 min, 2 h e 12 h; à quinta falha, "falhado".
- **`atualizado_em` só muda com os dados do lead**, não com tentativas de
  sincronização: é a data do último contacto que conta para a retenção.
- **Retenção de 12 meses** (alinhada com a política de privacidade), limpeza
  diária com `limpar_dados_antigos()`.

## Engenharia

- **Workflows definidos em JavaScript** (`scripts/workflows/`) e gerados por
  `scripts/build.js`. O código dos Code nodes vem de `/src`, testado; os
  exports em `/workflows` não têm IDs de credenciais nem de workflows (são
  resolvidos pelo nome no envio).
- **Os Code nodes gerados também são testados** (`tests/workflows.test.js`),
  com uma simulação de `$`, `$json` e `$input`: apanha nomes de nós trocados
  e campos inexistentes antes de chegar ao n8n.
- **Mensagens para o Discord sem menções**: texto do visitante com
  "@everyone" não notifica o canal.

- **Os bloqueios de tráfego ficam registados pelo próprio `guard-trafego`**
  (é a única peça que os vê), com a resposta fixa que o visitante recebeu.
- **Sem base de conhecimento ativa, o agente não é chamado** (motivo
  `sem_kb`): sem base, inventaria.
- **Memória com `contextWindowLength` = 6**: o nó conta interações (pergunta
  + resposta), não mensagens; 6 interações = as 12 mensagens decididas.
- **Custo estimado inclui as idas extra ao modelo** quando o agente usa
  tools (cada uma volta a enviar o contexto inteiro).

## Comportamento do bot

- **Marcação por link do Cal.com**, aberto num separador novo, com nome e
  email pré-preenchidos. O calendário não cabe na janela do chat.
- **O link é montado em código, não pelo LLM.** O agente escreve
  `[[MARCAR]]`; o pós-processamento troca-o pelo URL. Garante o URL certo e
  o máximo de duas chamadas à ação por conversa.
- **`motivo` do `avisar_humano` é um enum fechado.** Com texto livre, a
  idempotência "não avisar duas vezes salvo se o motivo mudar" não funciona.
- **Sem pedido de consentimento no chat** (2026-10-17). Quem dá o contacto
  quer ser contactado; a base legal é responder ao pedido da própria pessoa.
  O chat mostra uma linha com a política de privacidade, e a política passa a
  mencionar o chatbot. A coluna `consentimento` saiu da tabela `leads`.

## Notion

- **Pedidos à API do Notion por HTTP Request** (versão 2022-06-28), como o
  workflow "Site – Leads" já faz, em vez do nó Notion: controlo total do
  filtro "email OU telefone" e do PATCH/POST.
- **Telefone comparado pelos últimos 9 dígitos.** Nos CRMs aparece em vários
  formatos ("912345678", "+351912345678", "++351…").
- **Só se enviam campos com valor**, e Origem/Estado só na criação: o bot
  nunca apaga o que a equipa escreveu à mão nem lhe muda o Estado.

- **Base "Chatbot site" dentro de "CRM Clientes"**, separada do CRM dos
  comerciais. O bot nunca escreve nos CRMs dos comerciais.
- **Verificação só de leitura em dois CRMs** ("Clientes Site" e "CRM Nautica
  AI"), com uma integração Notion própria, só de leitura. Custa 2 pedidos por
  lead (longe do limite de ~3/s) e evita contactar duas vezes quem os
  comerciais já estão a trabalhar.
