/**
 * Guardas determinísticas, aplicadas antes de qualquer chamada ao LLM.
 *
 * JavaScript puro, sem require: o scripts/build.js copia este ficheiro
 * (até à linha de corte) para os Code nodes. Todas as funções recebem
 * a configuração como argumento, para se poderem testar sem o n8n.
 *
 * Duas famílias:
 *  - tráfego (sub-workflow guard-trafego, chamado pelos adaptadores públicos);
 *  - conteúdo e custo (chat-core, corre em todos os canais, incluindo o eval).
 */

/** Motivos de bloqueio. São também os valores gravados em turns.guarda. */
const MOTIVOS_BLOQUEIO = [
  'sessao_invalida',
  'sessao_bloqueada',
  'mensagem_vazia',
  'mensagem_longa',
  'quarentena',
  'limite_sessao',
  'teto_global',
  'kill_switch_custo',
  'pedido_invalido', // não é uma mensagem de texto (ex.: ficheiros enviados diretamente ao webhook)
  'sem_kb', // não há base de conhecimento ativa: o agente não responde sem ela
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Limpa o texto recebido: NFC, sem caracteres de controlo, espaços arrumados. */
function normalizarTexto(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Minúsculas e sem acentos, para as regras não dependerem da grafia. */
function paraComparar(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function validarSessionId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

/*
 * Regras de quarentena. Cada regra tem um id (fica registado no turno) e
 * corre sobre o texto sem acentos e em minúsculas, exceto as marcadas com
 * `original: true`.
 *
 * Critério: apanhar pedidos dirigidos ao bot (as instruções dele, os
 * segredos dele, mudar o papel dele), não temas. Um visitante pode
 * perguntar como guardamos as credenciais dos clientes; isso não é ataque.
 */
const REGRAS_INJECAO = [
  {
    id: 'ignorar_instrucoes',
    // "Regras" sozinho não chega ("posso ignorar as regras do IVA?"): só
    // conta com um qualificador que aponte para as instruções do bot.
    re: /\b(ignor[ae]\w*|esquec[ea]\w*|desconsider[ae]\w*|ignore|disregard|forget)\b.{0,40}(\b(instruc\w*|instructions?|prompts?)\b|\b(regras|ordens|indicac\w*|rules)\b.{0,20}\b(anteriores|acima|iniciais|previous|above|prior|que (te|lhe) deram)\b|\b(tudo|everything)\b.{0,15}\b(acima|anterior|above|before)\b)/,
  },
  {
    id: 'pedir_prompt',
    re: /\b(system ?prompt|prompt (do|de) sistema|prompt inicial|initial prompt|(instrucoes|regras|orientacoes) (do sistema|iniciais|internas|originais|secretas|que (te|lhe) (deram|foram dadas)|que recebeste)|your (instructions|rules|system message)|developer message)\b/,
  },
  {
    id: 'repetir_contexto',
    re: /\b(repete|repita|reescreve|reescreva|copia|copie|imprime|imprima|mostra|mostre|repeat|print|output|show)\b.{0,30}\b(tudo|todo o texto|o texto|everything|all|the text|the words)\b.{0,20}\b(acima|anterior|antes disto|above|before this)\b/,
  },
  {
    // Só segredos *do bot* (possessivo antes ou depois): "a tua API key",
    // "a password do vosso n8n". "Credenciais dos nossos clientes" passa.
    id: 'pedir_segredos',
    re: (() => {
      const dono = '(tua|teu|tuas|teus|vossa|vosso|vossas|vossos|your|do bot|do servidor|do n8n|da openai|do openrouter)';
      const segredo =
        '(api[ _-]?keys?|chaves? (da|de) api|chaves? secretas?|tokens?|passwords?|palavras?[- ]passe|senhas?|credenciais|credentials|secrets?|variaveis de ambiente|environment variables|\\.env)';
      return new RegExp(`\\b${dono}\\b\\W+(\\w+\\W+){0,3}${segredo}\\b|\\b${segredo}\\W+(\\w+\\W+){0,3}${dono}\\b`);
    })(),
  },
  {
    id: 'mudar_papel',
    re: /\b(a partir de agora (es|seras|vais ser|passas a ser|ages)|finge (que es|ser)|faz de conta que es|comporta-te como|you are now|from now on you|act as|pretend (to be|you are)|roleplay|jailbreak|modo (dev|desenvolvedor|developer|sem restricoes)|developer mode|do anything now)\b/,
  },
  {
    id: 'marcadores_sistema',
    original: true,
    re: /(<\|?\s*(system|im_start|im_end|endoftext)\s*\|?>|\[\/?(system|inst)\]|<\/?system>|^\s*#{1,6}\s*(system|instructions?)\s*:?\s*$)/im,
  },
  {
    // Base64 ou semelhante: um bloco longo sem espaços que mistura
    // maiúsculas, minúsculas e dígitos (texto repetido não conta).
    id: 'bloco_codificado',
    original: true,
    testa: (t) =>
      (t.match(/[A-Za-z0-9+/]{120,}={0,2}/g) || []).some((b) => /[A-Z]/.test(b) && /[a-z]/.test(b) && /\d/.test(b)),
  },
];

/** Devolve as regras de quarentena que o texto aciona (lista vazia = limpo). */
function detetarInjecao(texto) {
  const original = String(texto || '');
  const comparavel = paraComparar(original);
  return REGRAS_INJECAO.filter((r) => {
    const alvo = r.original ? original : comparavel;
    return r.testa ? r.testa(alvo) : r.re.test(alvo);
  }).map((r) => r.id);
}

/**
 * Guardas de conteúdo (chat-core). Corre em todos os canais.
 * `estado.quarentenasRecentes`: quarentenas da sessão na janela de bloqueio.
 */
function avaliarConteudo(payload, cfg, estado) {
  const quarentenas = (estado && estado.quarentenasRecentes) || 0;
  const texto = normalizarTexto(payload && payload.texto);
  const bloqueio = (motivo, regras) => ({ permitido: false, motivo, regras: regras || [], texto });

  if (!validarSessionId(payload && payload.session_id)) return bloqueio('sessao_invalida');
  if (quarentenas >= cfg.limites.quarentenasMaxPorSessao) return bloqueio('sessao_bloqueada');
  if (!texto) return bloqueio('mensagem_vazia');
  if (texto.length > cfg.limites.mensagemMaxChars) return bloqueio('mensagem_longa');

  const regras = detetarInjecao(texto);
  if (regras.length) return bloqueio('quarentena', regras);

  return { permitido: true, motivo: null, regras: [], texto };
}

/**
 * Guardas de tráfego (guard-trafego). As contagens já incluem o pedido
 * atual, porque o contador é incrementado antes de se avaliar.
 * O teto global vem primeiro: é a proteção real, porque o session_id é
 * gerado no cliente e pode ser rodado.
 */
function avaliarTrafego(contagens, cfg) {
  const l = cfg.limites;
  const c = contagens || {};
  if ((c.globalMin || 0) > l.globalPorMinuto || (c.globalDia || 0) > l.globalPorDia) {
    return { permitido: false, motivo: 'teto_global' };
  }
  if ((c.sessaoMin || 0) > l.sessaoPorMinuto || (c.sessaoDia || 0) > l.sessaoPorDia) {
    return { permitido: false, motivo: 'limite_sessao' };
  }
  return { permitido: true, motivo: null };
}

/** Kill switch: bloqueia quando o custo estimado do dia chega ao teto. */
function avaliarCusto(custoHojeEur, cfg) {
  if (Number(custoHojeEur || 0) >= cfg.limites.custoDiarioMaxEur) {
    return { permitido: false, motivo: 'kill_switch_custo' };
  }
  return { permitido: true, motivo: null };
}

/*
 * Estimativa de tokens. O AI Agent do n8n não passa o consumo real aos
 * nós seguintes, por isso o custo registado é estimado (~4 caracteres por
 * token). O valor real fica no painel do OpenRouter.
 */
function estimarTokens(texto) {
  return Math.ceil(String(texto || '').length / 4);
}

/**
 * Consumo estimado de um turno do agente. Cada chamada a uma tool é mais
 * uma ida ao modelo, que volta a receber o contexto inteiro (sistema + KB +
 * histórico + mensagem) e os passos anteriores.
 * `c`: { sistemaChars, historicoChars, textoChars, respostaChars,
 *        passos: [{ entrada, saida }] }  (entrada/saida das tools, em texto)
 */
function estimarConsumo(c, cfg) {
  const passos = c.passos || [];
  const base = (c.sistemaChars || 0) + (c.historicoChars || 0) + (c.textoChars || 0);
  const iteracoes = 1 + passos.length;
  let acumulado = 0;
  let entradaChars = 0;
  let saidaChars = c.respostaChars || 0;
  for (let i = 0; i < iteracoes; i++) {
    entradaChars += base + acumulado;
    if (i < passos.length) {
      const e = String(passos[i].entrada || '').length;
      const s = String(passos[i].saida || '').length;
      saidaChars += e;
      acumulado += e + s;
    }
  }
  const tokensEntrada = Math.ceil(entradaChars / 4);
  const tokensSaida = Math.ceil(saidaChars / 4);
  return { tokensEntrada, tokensSaida, custoEur: estimarCustoEur(tokensEntrada, tokensSaida, cfg) };
}

function estimarCustoEur(tokensEntrada, tokensSaida, cfg) {
  const m = cfg.modelo;
  const usd = (tokensEntrada * m.precoEntradaUsdPorMilhao + tokensSaida * m.precoSaidaUsdPorMilhao) / 1e6;
  return Math.round(usd * cfg.usdParaEur * 1e6) / 1e6;
}

/** Resposta fixa e útil para cada bloqueio. Nunca chama o LLM. */
function respostaFixa(motivo, cfg) {
  const cal = `[${cfg.cal.textoLink}](${cfg.cal.url})`;
  const email = cfg.site.emailContacto;
  const textos = {
    sessao_invalida: 'Não consegui ler esta conversa. Recarregue a página e tente outra vez.',
    sessao_bloqueada: `Esta conversa foi pausada. Se quiser falar connosco, pode ${cal} ou escrever para ${email}.`,
    mensagem_vazia: 'Não recebi nenhuma mensagem. Em que posso ajudar?',
    mensagem_longa: `A mensagem é um pouco longa para este chat. Consegue resumi-la em poucas frases? Se preferir explicar com calma, pode ${cal}.`,
    quarentena: `Não posso ajudar com esse pedido. Posso responder a perguntas sobre os serviços da Náutica AI ou ajudar a ${cal}.`,
    limite_sessao: `Está a enviar mensagens muito depressa. Aguarde um minuto e tente outra vez. Se preferir, pode ${cal}.`,
    teto_global: `De momento o assistente não está disponível. Pode ${cal} ou escrever para ${email}.`,
    kill_switch_custo: `De momento o assistente não está disponível. Pode ${cal} ou escrever para ${email}.`,
    pedido_invalido: `Este chat só aceita mensagens de texto. Se precisar de nos enviar um ficheiro, escreva para ${email}.`,
    sem_kb: `Desculpe, não consigo responder agora. Pode ${cal} ou escrever para ${email} e a nossa equipa responde-lhe.`,
    fallback: `Desculpe, não consegui responder agora. Pode ${cal} ou escrever para ${email} e a nossa equipa responde-lhe.`,
  };
  return textos[motivo] || textos.fallback;
}

// --- o build corta a partir daqui ---
module.exports = {
  MOTIVOS_BLOQUEIO,
  REGRAS_INJECAO,
  normalizarTexto,
  paraComparar,
  validarSessionId,
  detetarInjecao,
  avaliarConteudo,
  avaliarTrafego,
  avaliarCusto,
  estimarTokens,
  estimarConsumo,
  estimarCustoEur,
  respostaFixa,
};
