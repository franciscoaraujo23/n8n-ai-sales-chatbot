# O widget do site

O chat do site é um widget próprio: dois ficheiros (`chat.js` e `chat.css`,
no repositório do site) com cerca de **15 KB comprimidos** e sem
dependências. Integrá-lo numa página é uma linha:

```html
<script src="chat.js" defer></script>
```

O script cria o botão e o painel, carrega o próprio CSS e fala com o
workflow `chat-site` do n8n. Usa os tokens de design do site (cores,
tipografia, raios), com valores de recurso para funcionar mesmo numa página
sem eles.

## Porquê um widget próprio

O n8n tem um widget de chat genérico. Trocá-lo por um próprio permitiu o que
fazia diferença para a conversão:

- abrir o **calendário do Cal.com por cima do chat**, já com o nome e o email
  que o bot tem, e confirmar a marcação na própria conversa;
- uma personagem com identidade da marca no lugar de um ícone genérico;
- controlar ao pormenor o que é mostrado e como (segurança, acessibilidade,
  desempenho).

## O que faz

| | |
|---|---|
| **Personagem como botão** | No desktop, uma personagem ilustrada de corpo inteiro (SVG, volume com gradientes e luz de recorte) acena de vez em quando e quando se passa o rato. No telemóvel e no cabeçalho do chat, o busto num círculo. |
| **Balão por página** | Uma mensagem adaptada à página ("Qual destes encaixa em si?" nos serviços, "Gostou do que viu?" no laboratório). Nenhum balão onde já se está a marcar ou nas páginas legais. Fecha-se e não volta na sessão. |
| **Marcar chamada** | Botão sempre visível no cabeçalho, além dos links que o bot dá na conversa. Os dois abrem o calendário por cima do chat, preenchido. |
| **Confirmação** | Quando a marcação fica feita, o chat confirma-a ("Ficou marcado!") e a personagem festeja. |
| **Personagem viva** | A boca mexe enquanto o bot escreve; os olhos piscam. |
| **Respostas por ler** | Quem pergunta e fecha o chat antes da resposta vê um contador no botão, também entre páginas. |
| **Conversa contínua** | A conversa continua quando o visitante muda de página. |
| **Sugestões** | Três perguntas prontas na primeira abertura. |

## Segurança

- O texto do bot é **escapado** antes de qualquer formatação. Só depois se
  reconhecem links, negrito e listas.
- **Allowlist de links** também no cliente (o site e o Cal.com), como segunda
  linha de defesa para a do servidor.
- Os links do Cal.com abrem num separador novo com `rel="noopener"` quando o
  calendário não carrega.

## Privacidade

- O estado (identificador aleatório da conversa e mensagens) fica em
  `sessionStorage`: só naquela aba, apaga-se ao fechá-la. Sem cookies.
- O script do Cal.com só é carregado quando o visitante clica para marcar.

## Acessibilidade

- Botões com nomes acessíveis, incluindo o número de respostas por ler.
- O painel é um `dialog`; as mensagens estão num `role="log"` com
  `aria-live`, para os leitores de ecrã anunciarem as respostas.
- Teclado: Enter envia, Shift+Enter muda de linha, Esc fecha; o foco vai para
  o campo de texto ao abrir e volta ao botão ao fechar.
- `prefers-reduced-motion`: sem animações.
- No telemóvel, o painel ocupa o ecrã inteiro e o campo de texto tem 16 px,
  para o iOS não fazer zoom ao focar.

## Desempenho

O site já tinha efeitos visuais pesados (fundo animado, desfoque, grão de
filme), por isso o widget foi medido, não apenas desenhado:

- **~15 KB comprimidos** no total, sem bibliotecas.
- As animações contínuas da personagem correm só nos primeiros 20 segundos;
  depois ficam o piscar e o aceno ocasional, e tudo volta ao passar o rato.
  Medido com traces do Chrome: menos repintura por baixo do grão do site.
- A personagem vive numa camada própria (`will-change`), para as repinturas
  ficarem nela.
- O smooth scroll do site apanhava a roda do rato em toda a página e
  impedia o scroll das mensagens. Elementos com `data-scroll-proprio`
  passaram a ficar com o scroll nativo.

## Como foi testado

- **Chrome headless controlado por CDP**, com o webhook simulado: abrir,
  enviar, mudar de página, fechar antes da resposta, desktop e telemóvel, com
  capturas de ecrã de cada estado.
- Verificações automáticas no mesmo teste: formato do pedido, links que não
  podem aparecer (um `<img onerror>` e um domínio externo numa resposta
  simulada), persistência entre páginas, erros de JavaScript.
- **Teste de ponta a ponta em produção**: o site real a falar com o n8n real,
  incluindo o calendário do Cal.com aberto e preenchido.
