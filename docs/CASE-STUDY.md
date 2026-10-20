# Estudo de caso: o assistente do site da Náutica AI

Como construímos um chatbot de vendas em n8n que está em produção, quanto
custa, como sabemos que funciona e o que aprendemos pelo caminho.

## O objetivo

O site da Náutica AI recebe visitantes que ainda não estão prontos para
marcar uma chamada. O assistente existe para esse momento: responder às
dúvidas com a informação verdadeira da empresa, perceber o negócio do
visitante e, quando faz sentido, levá-lo à chamada de diagnóstico.

O sucesso mede-se por uma coisa: **um lead com contacto chega à equipa**, ou
o visitante marca a chamada sozinho.

As restrições foram definidas antes de escrever código:

- **Só a verdade da empresa.** Nada de preços, prazos ou clientes inventados.
  A informação vem de uma base de conhecimento editada por quem não programa.
- **Venda consultiva, sem pressão.** Uma pergunta de cada vez, honestidade
  quando a automação não compensa, sem urgência falsa nem descontos.
- **Português de Portugal**, sempre.
- **Custo previsível**, com teto diário.
- **Construído na ferramenta que a agência vende (n8n)**, e com qualidade para
  servir de exemplo do nosso trabalho.

## O princípio: o modelo escreve, o código decide

Um modelo de linguagem é ótimo a conversar e pouco fiável a cumprir regras.
Por isso, tudo o que tem de estar sempre certo saiu das mãos do modelo:

| O modelo faz | O código garante |
|---|---|
| Conversa, explica, faz perguntas | Bloqueia prompt injection antes de o modelo ver a mensagem |
| Decide quando propor a chamada (escreve `[[MARCAR]]`) | Monta o link do Cal.com com nome e email e aplica o limite de propostas |
| Decide quando registar um lead | Valida e limpa os dados; a conversa a que o lead pertence vem do sistema, nunca do modelo |
| Escreve links | Só deixa passar links do site e do Cal.com |
| — | Rate limits, teto de custo, resposta de recurso se o modelo falhar |

O resultado é um bot com personalidade, mas cujas falhas possíveis são
limitadas: no pior caso, diz algo fora do tom. Não consegue dar um link
malicioso, ver dados de outra conversa ou gastar sem limite.

## Como se constrói um workflow de n8n que se pode testar

O n8n é visual, e workflows desenhados à mão no editor são difíceis de rever,
versionar e testar. Aqui os workflows são **definidos em JavaScript**:

```
src/*.js ──► scripts/workflows/*.js ──► build.js ──► workflows/*.json ──► API do n8n
   │                                                        ▲
   └──► testes unitários           harness (simula o n8n) ──┘
```

- A lógica (guardas, validações, pós-processamento) vive em `src/`, em
  JavaScript puro, e o build copia-a para os Code nodes. **O código que corre
  em produção é o mesmo que os testes cobrem.**
- Um harness corre o código *exato* dos workflows gerados, com uma simulação
  de `$json`, `$input` e `$('nó')`. Apanha um nó com o nome trocado ou um
  campo inexistente antes de chegar ao n8n.
- As queries ao Postgres são testadas num Postgres 17 em memória (PGlite),
  com as migrations reais.
- Cada envio é validado com o n8n-mcp e confirmado pela API.

O primeiro teste em produção mostrou porque é que isto vale a pena. O
ambiente isolado dos Code nodes do n8n 2.29 não tem o objeto global `URL`, e
o pós-processamento falhou com um `ReferenceError`. A correção foi ler URLs
sem esse objeto. A lição ficou no próprio harness: passou a correr os Code
nodes sem `URL`, para este tipo de erro nunca mais passar os testes.

## Medir em vez de achar: os evals

Testes unitários cobrem o código, mas não dizem se o bot conversa bem. Para
isso há **evals**: conversas escritas como casos de teste (o que o visitante
diz, o que a resposta tem de ter e não pode ter, que ferramentas deve usar),
corridas contra o bot real.

Cada caso corre **cinco vezes**, porque um modelo responde de forma diferente
de cada vez. Uma melhoria medida com uma só corrida pode ser sorte. Hoje são
28 casos: perguntas frequentes, qualificação de um lead completa, preços fora
da base, honestidade sobre o encaixe, deriva para português do Brasil,
pedidos de uma pessoa, marcação, e uma bateria de 12 ataques.

Uma regra que poupou tempo: **ler as falhas antes de mexer no bot.** Na
primeira bateria, metade das "falhas" eram das verificações (paráfrases
corretas que uma expressão regular não apanhava). Corrigir a verificação,
reavaliar as respostas já gravadas e só depois tocar no prompt.

## Escolher o modelo com dados

O modelo provisório (`gpt-4.1-mini`) tinha um problema persistente: à
pergunta "que clientes já têm?", dizia que a empresa ainda não tinha clientes
antes de falar da redução de risco. Três formulações do prompt não
resolveram. Em vez de continuar a afinar o prompt para um modelo, testámos
cinco modelos baratos com a mesma bateria, através do agente do n8n tal como
está em produção:

| Modelo | Corridas certas | Observação |
|---|---|---|
| `claude-haiku-5.5` | 58/60 | Registou o lead em todas as conversas; o mais barato |
| `gemini-3.1-flash-lite` | 58/60 | Mais rápido, mas disse "já guardei o seu email" sem o guardar |
| `gpt-4.1-mini` | 55/60 | Falha persistente no "quem somos" |
| `gpt-5.6-luna` | 41/60 | Falhas dentro do agente do n8n |
| `mistral-small-2603` | 5/60 | Incompatível com o agente do n8n |

O empate decidiu-se pelo **tipo de falha**. Um bot que diz ao visitante que
guardou o contacto sem o guardar perde o lead e engana a pessoa: é a pior
falha possível neste produto. O Haiku custa cerca de 2 s a mais por
resposta, aceitável num chat com indicador de escrita.

## Problemas que só aparecem em produção

### Respostas cortadas a meio de uma palavra

Com o modelo novo, cerca de 8% das respostas saíam cortadas e algumas
vazias. As métricas dos evals mostraram que não era aleatório: o Haiku
**raciocina antes de responder**, e esse raciocínio contava para o teto de
700 tokens da resposta. Sobrava um espaço variável para o texto visível. Com
o teto a 2000 tokens (o tamanho visível continua limitado no
pós-processamento), os cortes e as respostas vazias desapareceram: zero em
110 respostas.

### Duas ferramentas no mesmo passo

Quando um visitante pedia para falar com uma pessoa e deixava o email na
mesma mensagem, a equipa recebia o aviso "sem contacto", e os leads de teste
chegavam ao Discord.

A primeira hipótese foi uma corrida entre as duas ferramentas a correr em
paralelo, e uma espera de 3 segundos não resolveu nada. Os dados mostraram
outra coisa: o aviso ficava gravado **0,4 s antes** do lead, em todas as
corridas. O n8n corre as ferramentas de um mesmo passo **em sequência**: o
aviso ia até ao fim, Discord incluído, antes de o lead existir.

A correção foi tirar o envio do caminho da ferramenta. O aviso regista-se e
responde logo ao agente; o workflow chama-se a si próprio sem esperar,
aguarda 10 segundos, relê o aviso e o lead e só então envia. Funciona seja
qual for a ordem, e a resposta ao visitante ficou mais rápida. A hipótese
errada ficou documentada nas decisões, com a medição que a desmentiu.

### O limite de propostas contra o próprio visitante

O bot propõe a chamada no máximo duas vezes por conversa, para não insistir.
Num teste real, o visitante pediu ajuda para marcar e deu o email depois de
o bot já ter usado as duas propostas. O código removeu o link e ficou uma
frase partida: "Pode agora:".

O limite existe para as propostas do bot, não para os pedidos do visitante.
Passou a haver uma exceção estreita: quando a mensagem pede a marcação ou o
link, ou o visitante acabou de deixar o email, o link passa sempre. A mesma
regra é usada no pós-processamento e nas verificações dos evals, e há um
caso de eval que reproduz exatamente a conversa real.

### Os evals a fechar o chat aos visitantes

O kill switch de custo tem um teto diário. No dia das comparações de modelos,
as baterias de evals esgotaram-no, e o chat do site ficaria fechado até à
meia-noite. Cada canal passou a ter o seu orçamento (site 1 €, evals 0,60 €),
e cada um conta só o que gastou. O núcleo continua sem decidir nada pelo
canal: o orçamento é um dado da configuração. Um canal sem orçamento definido
fica fechado por omissão.

## Testar sem sujar a produção

Cada bateria de evals cria dezenas de leads. Para não encherem o Notion nem o
canal da equipa, um lead com email de um domínio de teste (`exemplo.pt`, …)
fica só no Postgres, marcado como teste. Os avisos dessas conversas também
ficam marcados e não saem para o Discord. A regra decide pelo dado, não pelo
canal, por isso também protege de visitantes reais que escrevam um email de
exemplo.

## Uma base de conhecimento que não parte o bot

A base é um ficheiro Markdown no Google Drive, lido por uma conta de serviço
só com permissão de leitura nesse ficheiro. Cada versão nova é validada
contra um contrato (as secções obrigatórias) e identificada por um hash do
texto normalizado. Uma versão inválida nunca é ativada, a anterior continua a
funcionar e a equipa recebe um alerta. Sem base ativa, o agente nem é
chamado: sem base, inventaria.

## O widget

O widget do site é próprio (`chat.js` + `chat.css`, cerca de 15 KB
comprimidos, sem dependências) em vez do widget genérico do n8n. Isso
permitiu:

- abrir o calendário do Cal.com **por cima do chat**, já preenchido com os
  dados que o bot tem, e confirmar a marcação na conversa;
- uma personagem animada como botão, com mensagens diferentes por página e um
  botão "Marcar chamada" sempre visível;
- uma conversa que continua quando o visitante muda de página;
- acessibilidade (navegação por teclado, leitores de ecrã, movimento
  reduzido) e defesa em profundidade (HTML escapado, allowlist de links
  também no cliente).

Detalhe em [WIDGET.md](WIDGET.md).

## Resultado

| | |
|---|---|
| Em produção | desde outubro de 2026 |
| Workflows | 9 (2 adaptadores, núcleo, 2 ferramentas, guardas, base, manutenção, erros) |
| Testes | 100 unitários + 28 de SQL |
| Evals | 28 casos × 5 corridas; última bateria completa a 96–99% |
| Ataques | 60/60 |
| Latência | ~3 s por resposta (mediana) |
| Custo | ~0,0007 € por resposta |

## O que vem a seguir

- **WhatsApp como segundo canal.** O núcleo já é independente do canal: é
  escrever o adaptador.
- **Um avaliador LLM nos evals**, para medir a qualidade da venda além das
  verificações determinísticas.
- **Métricas de conversão** a partir da tabela de turnos: quantas conversas
  chegam a lead e a marcação.
