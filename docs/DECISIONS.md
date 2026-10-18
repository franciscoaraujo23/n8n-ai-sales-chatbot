# Decisões

Cada decisão com o porquê. As que mudaram têm a data e o motivo. Os factos
sobre o n8n marcados com "verificado" foram confirmados no código-fonte da
versão em produção (2.29.10), não na documentação.

## Arquitetura

- **Tudo em n8n, sem RAG.** A base de conhecimento é pequena e vai inteira no
  contexto. Menos peças, respostas mais consistentes, e a base é editada num
  ficheiro no Google Drive por quem não programa.
- **Adaptador por canal + núcleo (`chat-core`).** O núcleo recebe um payload
  canónico versionado (`schema_version: 1`) e não sabe de que canal veio a
  mensagem; um teste garante que nenhum Code node do núcleo decide pelo canal.
  Ligar o WhatsApp é escrever outro adaptador.
- **Guardas de tráfego num sub-workflow (`guard-trafego`)**, chamado por cada
  adaptador público. O adaptador de eval não o chama. Não há nenhuma flag de
  "saltar limites" no núcleo: seria uma porta aberta.
- **Guardas de conteúdo e kill switch de custo no núcleo**, para correrem em
  todos os canais, incluindo os evals: testa-se o mesmo bot que está em
  produção, e os evals também gastam dinheiro.
- **Teto global como proteção real.** O `session_id` é gerado no cliente e
  pode ser rodado; o teto global junta todos os canais públicos.
- **O Chat Trigger não expõe o IP nem os cabeçalhos** (verificado: o nó passa
  ao workflow só o corpo do pedido). Limitar por IP teria de ser no Caddy.
- **Sem limite por IP na v1.** Obrigaria a compilar o Caddy com um plugin,
  para um tráfego que ainda não existe. Revisitar se aparecer abuso real na
  tabela `rate_limits`.
- **Allowed Origins é só CORS** (verificado): define o cabeçalho da resposta,
  não recusa pedidos. Mais uma razão para o teto global ser a proteção real.
- **Ficheiros recusados na normalização.** Em modo Embedded, o Chat Trigger
  aceita `multipart/form-data` com ficheiros mesmo com uploads desligados no
  widget (verificado: a opção só se aplica ao chat alojado pelo n8n).
- **Os bloqueios de tráfego são registados pelo próprio `guard-trafego`**: é a
  única peça que os vê, e o núcleo nem chega a correr.

## Comportamento do bot

- **Venda consultiva escrita como regras no prompt** (`prompts/system.md`):
  responder primeiro, uma pergunta de cada vez, ligar a dor a um serviço,
  honestidade sobre o encaixe, sem urgência falsa nem descontos, nunca
  inventar fora da base.
- **Marcação por link do Cal.com, aberto num separador novo**, com nome e
  email pré-preenchidos. Sem pop-up: o calendário não cabe na janela do chat.
  O widget já abre links num separador novo (verificado no `@n8n/chat`).
- **O link é montado em código, não pelo LLM.** O agente escreve
  `[[MARCAR]]`; o pós-processamento troca-o pelo URL com os dados gravados
  nesse mesmo turno. Garante o URL certo e o máximo de duas chamadas à ação
  por conversa, também em código.
- **Allowlist de links na resposta** (site e Cal.com da Nautica). O widget
  escapa HTML e não torna URLs soltos clicáveis (verificado), por isso o único
  link útil é o Markdown que o código monta ou deixa passar.
- **`motivo` do `avisar_humano` é um enum fechado.** Com texto livre, a
  idempotência "não avisar duas vezes salvo se o motivo mudar" não funciona.
- **Lead com contacto avisa a equipa automaticamente** (2026-10-18). O
  objetivo comercial do bot é um lead com contacto chegar à equipa; nos evals
  o modelo esqueceu-se de chamar `avisar_humano` em 4 de 5 conversas. O
  `tool-registar-lead` avisa sozinho (`lead_qualificado`) depois da
  sincronização, para o aviso já levar o link do Notion e a verificação nos CRMs.
- **`lead_qualificado` reservado ao aviso automático.** Se o agente o pedir,
  passa a `outro`: um aviso prematuro, ainda sem contacto, ocupava o par
  (conversa, motivo) e bloqueava o automático.
- **`avisar_humano` espera 3 s quando a conversa ainda não tem contacto**
  (2026-10-18). O agente do n8n corre em paralelo as tools pedidas no mesmo
  passo. Quem pede uma pessoa e deixa o email na mesma mensagem dispara
  `registar_lead` e `avisar_humano` ao mesmo tempo, e o aviso lia a conversa
  antes de o lead estar gravado: a equipa recebia "sem contacto" e os leads
  de teste chegavam ao Discord. Com o contacto já gravado não há espera; sem
  ele, o turno demora mais uns 2 s, só nesse caso. Pôr a ordem no prompt não
  chega, porque as duas chamadas saem na mesma resposta do modelo.
- **Objeções respondidas como na base**, sem sublinhar o que a empresa ainda
  não tem. Com o `gpt-4.1-mini`, o caso "quem-somos" continua a falhar (o bot
  diz que não tem clientes antes de reduzir o risco); três formulações do
  prompt não resolveram, e a pela negativa piorou. Ficou como critério da
  escolha do modelo; com o Haiku já não acontece (ver "Modelo e custos").
- **O `session_id` das tools vem do contexto, nunca do LLM**: o modelo não
  pode registar dados noutra conversa.
- **Sem base de conhecimento ativa, o agente não é chamado** (motivo
  `sem_kb`): sem base, inventaria. O visitante recebe o fallback e a equipa um
  alerta.
- **Sem pedido de consentimento no chat** (2026-10-17). Quem dá o contacto
  quer ser contactado: a base legal é responder ao pedido da própria pessoa
  (diligências pré-contratuais). O chat mostra uma linha com a política de
  privacidade, e a política passou a mencionar o chatbot. A coluna
  `consentimento` saiu da tabela `leads`.

## Modelo e custos

- **Modelo configurável num único sítio** (`src/config.js`). Provisório e
  barato até ao eval; a escolha final é um critério do eval, não um palpite.
- **`anthropic/claude-haiku-5.5`** (2026-10-18). Cinco candidatos baratos com
  suporte de tools no OpenRouter, a mesma bateria (12 casos × 5 corridas)
  através do `chat-eval`, ou seja, com o agente do n8n tal como está em
  produção, e todas reavaliadas com as mesmas verificações:

  | Modelo | USD/1M entrada / saída | Corridas certas | Fallbacks | Latência p50 / p90 |
  |---|---|---|---|---|
  | `claude-haiku-5.5` | 0,10 / 0,50 | 58/60 | 0 | 3,5 s / 4,4 s |
  | `gemini-3.1-flash-lite` | 0,25 / 1,50 | 58/60 | 0 | 1,5 s / 2,1 s |
  | `gpt-4.1-mini` (provisório) | 0,40 / 1,60 | 55/60 | 0 | 1,6 s / 2,4 s |
  | `gpt-5.6-luna` | 0,20 / 1,20 | 41/60 | 19 de 85 | — |
  | `mistral-small-2603` | 0,15 / 0,60 | 5/60 | 72 de 85 | — |

  O empate entre o Haiku e o Gemini decide-se pelo tipo de falha. O Gemini
  disse "já tomei nota" e "já adicionei o seu email" sem chamar
  `registar_lead`, e numa das 5 conversas o lead perdeu-se: é a pior falha
  possível num bot cujo objetivo é o lead chegar à equipa. O Haiku registou o
  lead nas 5 conversas, e as suas 2 falhas são no "quem-somos" por não
  mencionar a redução de risco (nunca diz que não há clientes, que era a falha
  do `gpt-4.1-mini`). É também o mais barato. O custo é a latência, cerca de
  2 s a mais, aceitável num chat com indicador de escrita. O Luna e o Mistral
  falham dentro do agente do n8n (resposta de fallback), por isso não foram
  avaliados quanto à qualidade; o DeepSeek ficou de fora por guardar os dados
  na China. Sem cache de prompt (ver abaixo), o Haiku continua o mais barato.
  Revisitar se a latência pesar na conversão ou se o preço mudar.
- **Cache de prompt como critério de escolha do modelo.** A mensagem de
  sistema é prompt + base (fixos) + estado da conversa (no fim): o prefixo
  estável aproveita a cache automática dos fornecedores que a têm. Os modelos
  da Anthropic via OpenRouter precisam de `cache_control` explícito, que o nó
  do n8n não envia.
- **Custo estimado, não medido.** O AI Agent não passa o consumo de tokens aos
  nós seguintes. A estimativa (~4 caracteres por token) conta as idas extra ao
  modelo quando o agente usa tools, porque cada uma reenvia o contexto inteiro.
- **Dois travões de custo:** o kill switch diário no núcleo (1 €/dia,
  estimado; um gasto acima disso com este tráfego é quase de certeza abuso ou
  um bug) e o limite de crédito na própria chave do OpenRouter (real).
- **Memória com `contextWindowLength` = 6**: o nó conta interações (pergunta +
  resposta), não mensagens; 6 interações são as 12 mensagens decididas.

## Dados

- **Migrations escritas no repositório, aplicadas por SSH** com
  `sql/aplicar.sh`. O Postgres não está exposto, e ainda bem.
- **A tabela da memória (`chat_memoria`) é criada pelo nó Postgres Chat
  Memory**, não pela migration: o nó espera um schema concreto e replicá-lo à
  mão arrisca falhas pouco óbvias.
- **Lógica com estado em funções SQL atómicas**, testadas em PGlite
  (Postgres 17 em memória): contadores, ativação da base, idempotência dos
  avisos, reserva para sincronizar, anti-spam. Os workflows chamam-nas com um
  único parâmetro `jsonb`, para vírgulas e nulls nunca partirem a query.
- **Sincronização com o Notion controlada no Postgres.** Uma reserva com
  prazo impede que a tool e a nova tentativa agendada tratem o mesmo lead ao
  mesmo tempo (o que criaria duas páginas). Se os dados mudam durante a
  sincronização, o lead volta a pendente em vez de as alterações se perderem.
  Backoff de 5 min, 30 min, 2 h e 12 h; à quinta falha, "falhado" e alerta.
- **As novas tentativas de sincronização ficam no `tool-registar-lead`**, como
  segundo trigger (Schedule de 5 min), e não num workflow próprio
  (2026-10-18). A cadeia de sincronização é uma só para a tool e para as novas
  tentativas, e a reserva com prazo no Postgres já impede que as duas tratem o
  mesmo lead. Separar obrigava a duplicar a cadeia ou a criar um terceiro
  sub-workflow, sem tirar risco. Revisitar se for preciso desligar as novas
  tentativas sem tocar na tool, ou se aparecer outra origem de leads.
- **`atualizado_em` só muda com os dados do lead**, não com tentativas de
  sincronização: é a data do último contacto que conta para a retenção.
- **Sem gravação de execuções bem-sucedidas** em nenhum workflow do chatbot:
  contêm texto e dados pessoais dos visitantes. Os erros continuam a ser
  gravados; o que é preciso de cada turno fica na tabela `turns`.
- **A base de conhecimento é lida por uma conta de serviço Google**, não por
  OAuth (2026-10-18). Três razões: acesso só a este documento (o ficheiro é
  partilhado com a conta de serviço, como leitor, e com mais ninguém); só
  leitura (scope `drive.readonly` e domínio permitido só `www.googleapis.com`);
  e sem expiração de token (o OAuth depende do login de uma pessoa, e com a
  app em modo de teste o Google expira o token ao fim de 7 dias). O custo é
  uma chave privada de longa duração no n8n, rodada à mão (RUNBOOK).
- **A base é um `.md` no Drive, não um Google Doc.** O `kb-sync` descarrega-o
  tal como está; se um dia passar a Google Doc, exporta-o em Markdown sem
  mudar mais nada. Atualizar com "Gerir versões → Carregar nova versão", para
  o ID do ficheiro não mudar.
- **Retenção de 12 meses** (alinhada com a política de privacidade), limpeza
  diária com `limpar_dados_antigos()`; erros, 3 meses.

## Notion

- **Base "Chatbot site" dentro de "CRM Clientes"**, separada do CRM dos
  comerciais. O bot nunca escreve nos CRMs dos comerciais.
- **Verificação só de leitura em dois CRMs** ("Clientes Site" e "CRM Nautica
  AI"), com uma integração Notion própria, só com permissão de leitura: a
  regra não depende de disciplina. Custa 2 pedidos por lead (longe do limite
  de ~3/s) e evita contactar duas vezes quem os comerciais já trabalham.
- **Pedidos à API do Notion por HTTP Request** (versão 2022-06-28), como o
  workflow "Site – Leads" já faz, em vez do nó Notion: controlo total do
  filtro "email OU telefone" e do PATCH/POST.
- **Telefone comparado pelos últimos 9 dígitos.** Nos CRMs aparece em vários
  formatos ("912345678", "+351912345678", "++351…").
- **Só se enviam campos com valor**, e Origem/Estado só na criação: o bot
  nunca apaga o que a equipa escreveu à mão nem lhe muda o Estado.

## Erros

- **Um error-handler com duas entradas**: o Error Trigger (erros não tratados,
  de todos os workflows) e uma chamada direta para erros TRATADOS — o
  visitante recebe uma resposta útil, mas a equipa tem de saber: falha a
  gravar o turno, agente que falhou, base em falta, aviso que o Discord
  recusou, lead que desistiu de sincronizar.
- **Os avisos de erro tratados vão em linha, sem esperar.** Um sub-workflow
  devolve a saída do último nó executado; um ramo paralelo podia acabar em
  último e trocar a resposta. O Execute Workflow sem espera devolve o item que
  recebeu (verificado), por isso o fluxo principal segue com os mesmos dados.
- **Logging nunca parte a resposta** (`continueErrorOutput`), e a falha conta
  como erro para o error-handler.
- **Anti-spam por workflow (5 minutos)**, decidido em SQL com um lock; o
  alerta desmarca-se se o Discord falhar, para o próximo erro tentar outra vez.
- **O alerta nunca leva a mensagem de erro**, que pode ter texto de
  visitantes; fica só no Postgres. Erros tratados não têm link para a
  execução (as bem-sucedidas não são gravadas).
- **Mensagens para o Discord sem menções**: texto do visitante com
  "@everyone" não notifica o canal.

## Engenharia

- **Workflows definidos em JavaScript** (`scripts/workflows/`) e gerados por
  `scripts/build.js`. O código dos Code nodes vem de `/src`, testado. Os
  exports em `/workflows` não têm IDs de credenciais nem de workflows: são
  resolvidos pelo nome no envio (sem distinguir maiúsculas).
- **Os Code nodes gerados também são testados** (`tests/harness.js`), com uma
  simulação de `$`, `$json` e `$input`: apanha nomes de nós trocados e campos
  inexistentes antes de chegar ao n8n.
- **IDs de nós e de webhooks determinísticos.** O URL do widget não muda entre
  envios, e os exports só mudam quando o conteúdo muda.
- **Sem `URL` nos Code nodes.** O ambiente isolado dos Code nodes do n8n
  2.29 não tem o objeto global `URL` (descoberto no primeiro teste real: um
  `ReferenceError` no pós-processamento). O código de `/src` lê URLs à mão, e o
  harness dos testes corre os Code nodes sem `URL` nem `URLSearchParams`.
- **Sub-workflows publicados antes de quem os chama.** O n8n 2.x recusa
  publicar um workflow que referencia sub-workflows não publicados. Um envio
  pela API a um workflow publicado atualiza logo a versão em produção.
- **Envio sempre inativo** para workflows novos; validação com o n8n-mcp antes
  e depois de cada envio.
- **Repositório em LF** (`.gitattributes`): o `aplicar.sh` corre no Linux da
  VPS e partia com CRLF.

## Evals

- **Adaptador próprio (`chat-eval`) com Header Auth**, a chamar o núcleo sem o
  `guard-trafego`. Com o webhook de teste do n8n, o editor teria de estar à
  escuta, e os limites de tráfego bloqueariam o próprio eval.
- **Verificações determinísticas, não um juiz LLM**: guarda, tools, chamada à
  ação, pt-BR, preços fora da base, fugas do prompt. A qualidade da venda lê-se
  nos resultados gravados.
- **Cada caso corre 5 vezes e conta a taxa de acerto** (2026-10-18). As
  respostas do modelo variam de corrida para corrida; com uma só corrida, uma
  comparação antes/depois pode melhorar ou piorar por sorte. `--reavaliar`
  aplica as verificações atuais a respostas já gravadas, para comparar com as
  mesmas regras sem voltar a chamar o bot.
- **Ler as falhas antes de mexer no bot.** Na primeira bateria, metade das
  falhas eram da verificação (paráfrases honestas que as regex não
  apanhavam, um "marcar" confundido com o marcador). Corrigir a verificação e
  reavaliar; só depois corrigir o bot.
- **Leads de teste sem efeitos reais** (2026-10-18, substitui a opção B).
  Leads cujo email final é de um domínio de teste (`CONFIG.leadsTeste`) ficam
  só no Postgres (`sync_estado = 'teste'`): sem Notion, sem Discord, fora das
  novas tentativas. A regra decide pelo dado, não pelo canal, e protege também
  de visitantes que escrevem emails de exemplo. Com 5 corridas por caso, a
  opção B enchia o canal de leads.
