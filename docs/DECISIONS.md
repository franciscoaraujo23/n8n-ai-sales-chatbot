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
- **Retenção de 12 meses** (alinhada com a política de privacidade), limpeza
  diária com `limpar_dados_antigos()`.

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

- **Base "Chatbot site" dentro de "CRM Clientes"**, separada do CRM dos
  comerciais. O bot nunca escreve nos CRMs dos comerciais.
- **Verificação só de leitura em dois CRMs** ("Clientes Site" e "CRM Nautica
  AI"), com uma integração Notion própria, só de leitura. Custa 2 pedidos por
  lead (longe do limite de ~3/s) e evita contactar duas vezes quem os
  comerciais já estão a trabalhar.
