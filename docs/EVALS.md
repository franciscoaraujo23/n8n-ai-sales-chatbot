# Evals: como se mede a qualidade do bot

Os testes unitários garantem que o código faz o que deve. Os evals respondem
a outra pergunta: **o bot, a conversar com um visitante, comporta-se como
queremos?** Cada eval é uma conversa escrita como caso de teste e corrida
contra o bot real, em produção, com o mesmo agente, prompt, base de
conhecimento e pós-processamento.

## Um caso

```json
{
  "id": "faq-servicos",
  "categoria": "perguntas_frequentes",
  "descricao": "Pergunta direta sobre serviços: responde com a base, sem propor a chamada logo na primeira resposta.",
  "turnos": [
    {
      "texto": "Olá! Que serviços é que vocês oferecem?",
      "esperado": {
        "guarda": null,
        "deve_conter": ["/automa/i"],
        "sem_tools": true,
        "cta": false,
        "max_chars": 1200
      }
    }
  ]
}
```

Cada turno tem o texto do visitante e o que se espera da resposta:

| Verificação | O que confirma |
|---|---|
| `guarda` | A guarda que travou a mensagem (`quarentena`, `kill_switch_custo`, …) ou `null` se chegou ao modelo |
| `deve_conter` / `nao_deve_conter` | Texto ou expressões regulares na resposta |
| `tools_inclui` / `tools_exclui` / `sem_tools` | Que ferramentas o agente usou |
| `cta` | Se a resposta propôs a chamada (o link de marcação) |
| `max_chars` | Tamanho da resposta |

Em todos os turnos correm sempre três verificações: **sem resposta de
recurso** (o modelo não falhou), **sem marcas de português do Brasil** e **só
preços que existam na base**. No fim da conversa há verificações da conversa
inteira, por exemplo "no máximo duas chamadas à ação por iniciativa do bot" ou
"registou o lead em algum turno".

## Cinco corridas por caso

Um modelo de linguagem não responde duas vezes da mesma maneira. Com uma só
corrida, uma mudança ao prompt pode parecer melhorar ou piorar por sorte. Por
isso cada caso corre **5 vezes** e o resultado é uma taxa de acerto:

```
100%  5/5  faq-servicos  (perguntas_frequentes)
 80%  4/5  quem-somos  (nunca_dizer)
              1x turno 1: não contém /n[ãa]o (temos|tem|h[áa]) (ainda )?clientes/i
Corridas certas: 79/80 (99%). Casos a 100%: 15/16.
```

Todas as respostas ficam gravadas. `--reavaliar <ficheiro>` volta a aplicar
as verificações atuais a respostas já gravadas, sem chamar o bot: quando uma
verificação é corrigida, compara-se tudo com as mesmas regras e sem custo.

## Os casos

28 casos, agrupados pelo que testam:

| Categoria | Casos | O que protege |
|---|---|---|
| Perguntas frequentes | serviços, processo, "é uma pessoa ou um bot?" | Respostas fiéis à base, sem forçar a venda |
| Fora do âmbito | pedido sem relação com a empresa | Recusa com simpatia e volta ao tema |
| Preços | preço fora da base, nome de plano | Nunca inventa nem revela preços internos |
| Português | deriva para pt-BR, visitante em inglês | Sempre português de Portugal |
| Qualificação | conversa completa até ao email (5 turnos) | O lead é registado com os dados certos |
| Honestidade | volume baixo em que a automação não compensa | Diz que não compensa em vez de vender |
| O que nunca dizer | clientes, marcação direta na agenda | Respeita as regras da base |
| Passagem a uma pessoa | "prefiro falar com alguém" | Regista o contacto e avisa a equipa |
| Chamada à ação | insistir no link, "marque por mim", pedido depois do limite | O link aparece quando deve, preenchido |
| Segurança | 12 ataques (ver [SECURITY.md](SECURITY.md)) | Nada de fugas, links ou código perigosos |

## O adaptador dos evals

Os evals entram por um adaptador próprio (`chat-eval`), um webhook com
autenticação por cabeçalho que chama o mesmo núcleo do site. Duas diferenças
em relação ao site:

- **Não passa pelos limites de tráfego**, que bloqueariam a própria bateria.
  O núcleo não tem nenhuma opção para "saltar limites": a diferença está no
  adaptador.
- **Tem orçamento próprio** no kill switch de custo (0,60 €/dia). Os evals
  nunca gastam o orçamento do site.

Os leads criados pelos evals usam emails de domínios de teste e ficam só no
Postgres, marcados como teste: não vão para o Notion nem geram avisos no
Discord.

## Escolha do modelo

O modelo foi escolhido com esta bateria. Cinco candidatos baratos com suporte
de ferramentas, 12 casos × 5 corridas cada, através do agente do n8n tal como
está em produção, e todas as baterias reavaliadas com as mesmas verificações:

| Modelo | USD/1M tokens (entrada / saída) | Corridas certas | Latência p50 / p90 |
|---|---|---|---|
| `claude-haiku-5.5` | 0,10 / 0,50 | 58/60 | 3,5 s / 4,4 s |
| `gemini-3.1-flash-lite` | 0,25 / 1,50 | 58/60 | 1,5 s / 2,1 s |
| `gpt-4.1-mini` | 0,40 / 1,60 | 55/60 | 1,6 s / 2,4 s |
| `gpt-5.6-luna` | 0,20 / 1,20 | 41/60 | — |
| `mistral-small-2603` | 0,15 / 0,60 | 5/60 | — |

O empate decidiu-se pelo tipo de falha: o Gemini dizia ao visitante que tinha
guardado o email sem chamar a ferramenta que o guarda, e numa das conversas o
lead perdeu-se. O raciocínio completo está nas
[decisões](DECISIONS.md#modelo-e-custos).

## Métricas que os evals também mostram

Além das verificações, o runner mede o que um humano não veria a ler meia
dúzia de respostas: latência (p50 e p90), respostas de recurso e **respostas
cortadas**. Foi esta última métrica que mostrou que o modelo escolhido
raciocinava antes de responder e esgotava o teto de tokens (ver o
[estudo de caso](CASE-STUDY.md#respostas-cortadas-a-meio-de-uma-palavra)).

## Verificar as verificações

Uma verificação errada é pior do que nenhuma: dá confiança falsa. Três
práticas:

1. **Ler as falhas antes de mexer no bot.** Muitas falhas iniciais eram
   paráfrases corretas que uma expressão regular não apanhava.
2. **Testes aos próprios evals.** Os casos são validados (JSON bem formado,
   ids únicos, sem caracteres de controlo). Num ficheiro JSON, um `\b` mal
   escapado vira um backspace e a expressão regular deixa de apanhar o que
   devia, em silêncio. Um teste garante que isso não volta a acontecer.
3. **A mesma regra no bot e no eval.** Quando o bot decide algo em código (por
   exemplo, se o visitante pediu o link de marcação), o eval usa a mesma
   função, importada de `src/`, em vez de uma cópia que pode divergir.

## Correr

```bash
npm run evals                                # todos os casos, 5 corridas
node evals/correr.js quem-somos --repeticoes 10
node evals/correr.js --reavaliar evals/resultados/<ficheiro>.json
```

Precisa de `.env` com o URL e o token do adaptador (ver `.env.example`). Uma
bateria completa custa cerca de 0,10 € e demora 6 a 8 minutos.
