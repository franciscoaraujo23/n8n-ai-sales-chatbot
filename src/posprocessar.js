/**
 * Pós-processamento da resposta do agente, antes de chegar ao visitante.
 *
 * Ordem: links fora da allowlist → corte por tamanho → chamada à ação
 * (marcador trocado pelo link do Cal.com) → deteção de português do Brasil.
 * O corte vem antes do link do Cal.com para o URL não contar para o
 * tamanho visível nem ser cortado a meio.
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 */

/** O URL pode aparecer numa resposta? Só https, sem credenciais nem porta. */
function linkPermitido(url, cfg) {
  if (/^mailto:/i.test(url)) {
    return url.slice(7).split('?')[0].toLowerCase() === cfg.site.emailContacto.toLowerCase();
  }
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const caminho = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
  return cfg.linksPermitidos.some((p) => u.hostname === p.host && caminho.startsWith(p.prefixo));
}

/**
 * Remove links fora da allowlist. Num link Markdown fica só o texto; um
 * URL solto desaparece. Devolve também os URLs removidos, para o log.
 */
function filtrarLinks(texto, cfg) {
  const removidos = [];
  const guardados = [];
  const marca = (i) => `\u0000${i}\u0000`;

  // 1. Links Markdown: [texto](url)
  let t = String(texto).replace(/\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g, (m, txt, url) => {
    if (linkPermitido(url, cfg)) {
      guardados.push(m);
      return marca(guardados.length - 1);
    }
    removidos.push(url);
    return txt;
  });

  // 2. URLs soltos (com esquema, www. ou mailto:)
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>()[\]]+|\bmailto:[^\s<>()[\]]+/gi, (m) => {
    const final = (m.match(/[.,;:!?'"»]+$/) || [''])[0];
    const url = m.slice(0, m.length - final.length);
    const comEsquema = /^www\./i.test(url) ? 'https://' + url : url;
    if (linkPermitido(comEsquema, cfg)) return m;
    removidos.push(url);
    return final;
  });

  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => guardados[Number(i)]);
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1');
  return { texto: t.trim(), removidos };
}

/**
 * Corta acima do limite, de preferência no fim de uma frase. Nunca deixa
 * um link Markdown ou um marcador a meio.
 */
function cortarResposta(texto, max) {
  const t = String(texto);
  if (t.length <= max) return { texto: t, cortada: false };

  let corte = t.slice(0, max);
  const abre = corte.lastIndexOf('[');
  if (abre > corte.lastIndexOf(')')) corte = corte.slice(0, abre);

  const fimFrase = Math.max(
    corte.lastIndexOf('. '),
    corte.lastIndexOf('! '),
    corte.lastIndexOf('? '),
    corte.lastIndexOf('.\n'),
    corte.lastIndexOf('!\n'),
    corte.lastIndexOf('?\n')
  );
  if (fimFrase >= max * 0.5) return { texto: corte.slice(0, fimFrase + 1).trim(), cortada: true };

  const espaco = corte.search(/\s\S*$/);
  if (espaco > 0) corte = corte.slice(0, espaco);
  return { texto: corte.replace(/[\s,;:–-]+$/, '') + '…', cortada: true };
}

/** URL do Cal.com com nome e email pré-preenchidos (só os que existem). */
function urlCal(nome, email, cfg) {
  const u = new URL(cfg.cal.url);
  if (nome) u.searchParams.set('name', nome);
  if (email) u.searchParams.set('email', email);
  return u.toString();
}

/**
 * Troca o primeiro marcador pelo link do Cal.com, se a conversa ainda não
 * esgotou as chamadas à ação. Os restantes marcadores são removidos.
 * Um link do Cal.com escrito diretamente pelo agente também conta.
 */
function aplicarCta(texto, ctx, cfg) {
  const marcador = cfg.marcadorCta;
  const anteriores = (ctx && ctx.ctasAnteriores) || 0;
  const podeUsar = anteriores < cfg.limites.ctasMaxPorConversa;
  let usada = false;

  let t = String(texto)
    .split(marcador)
    .reduce((acc, parte, i) => {
      if (i === 0) return parte;
      if (podeUsar && !usada) {
        usada = true;
        const url = urlCal(ctx && ctx.nome, ctx && ctx.email, cfg);
        return acc + `[${cfg.cal.textoLink}](${url})` + parte;
      }
      return acc + parte;
    }, '');

  // Arruma o que sobra de marcadores removidos (bullets vazios, espaços).
  t = t
    .replace(/^[ \t]*[-*•][ \t]*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!usada) {
    const cal = new URL(cfg.cal.url);
    usada = t.includes(cal.hostname + '/' + cal.pathname.split('/')[1] + '/');
  }
  return { texto: t, ctaUsada: usada };
}

const MARCADORES_PT_BR = [
  { id: 'gerundio', re: /\b(estou|esta|estamos|estao|estava|estavamos|fico|ficamos|continuo|continua|seguimos|vou ficar)\s+\w+(ando|endo|indo)\b/ },
  { id: 'voce', re: /\bvoce\b/ },
  { id: 'lexico', re: /\b(contato|contatos|contatar|celular|planilhas?|equipe|usuarios?|cadastr\w*|registrar|registrou|aplicativo|onibus|de fato|bacana|pra|xicara)\b/ },
  { id: 'acentuacao', original: true, re: /[a-zà-ú]*(ômic|ônic|ônim|ônio|êmic|ênic|ênio)[a-zà-ú]*/i },
];

/** Sinal (não bloqueia) de deriva para português do Brasil. */
function detetarPtBr(texto) {
  const original = String(texto || '');
  const comparavel = original.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const marcadores = MARCADORES_PT_BR.filter((m) => m.re.test(m.original ? original : comparavel)).map((m) => m.id);
  return { suspeito: marcadores.length > 0, marcadores };
}

/**
 * Pipeline completo. `ctx`: { nome, email, ctasAnteriores } da sessão.
 */
function posProcessar(texto, ctx, cfg) {
  const links = filtrarLinks(texto || '', cfg);
  const corte = cortarResposta(links.texto, cfg.limites.respostaMaxChars);
  const cta = aplicarCta(corte.texto, ctx, cfg);
  const ptBr = detetarPtBr(cta.texto);
  return {
    texto: cta.texto,
    vazia: !cta.texto,
    linksRemovidos: links.removidos,
    cortada: corte.cortada,
    ctaUsada: cta.ctaUsada,
    ptBr,
  };
}

// --- o build corta a partir daqui ---
module.exports = {
  MARCADORES_PT_BR,
  linkPermitido,
  filtrarLinks,
  cortarResposta,
  urlCal,
  aplicarCta,
  detetarPtBr,
  posProcessar,
};
