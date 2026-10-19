/**
 * Pós-processamento da resposta do agente, antes de chegar ao visitante.
 *
 * Ordem: links fora da allowlist → links do Cal.com passam a marcador →
 * corte por tamanho → chamada à ação (marcador trocado pelo link do
 * Cal.com) → URLs soltos passam a clicáveis → deteção de português do Brasil.
 * O corte vem antes do link do Cal.com para o URL não contar para o
 * tamanho visível nem ser cortado a meio.
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 */

/**
 * Partes de um URL http(s). Os Code nodes do n8n correm num ambiente
 * isolado sem o objeto global URL, por isso a leitura é feita aqui.
 * Devolve null se não for um URL http(s) válido.
 */
function partirUrl(url) {
  const m = /^(https?):\/\/(?:([^@/?#]*)@)?([^/:?#]+)(?::(\d*))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(String(url).trim());
  if (!m) return null;
  return {
    protocolo: m[1].toLowerCase(),
    credenciais: m[2] || '',
    host: m[3].toLowerCase(),
    porta: m[4] || '',
    caminho: m[5] || '/',
    query: m[6] || '',
  };
}

/** O URL pode aparecer numa resposta? Só https, sem credenciais nem porta. */
function linkPermitido(url, cfg) {
  if (/^mailto:/i.test(url)) {
    return url.slice(7).split('?')[0].toLowerCase() === cfg.site.emailContacto.toLowerCase();
  }
  const u = partirUrl(url);
  if (!u || u.protocolo !== 'https' || u.credenciais || u.porta) return false;
  const caminho = u.caminho.endsWith('/') ? u.caminho : u.caminho + '/';
  return cfg.linksPermitidos.some((p) => u.host === p.host && caminho.startsWith(p.prefixo));
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
  const params = [];
  if (nome) params.push('name=' + encodeURIComponent(nome));
  if (email) params.push('email=' + encodeURIComponent(email));
  return cfg.cal.url + (params.length ? '?' + params.join('&') : '');
}

/** Conta do Cal.com no URL configurado ("nautica-ai-xuismz"). */
function contaCal(cfg) {
  const u = partirUrl(cfg.cal.url);
  return u ? u.caminho.split('/')[1] : '';
}

/**
 * Troca o primeiro marcador pelo link do Cal.com, se a conversa ainda não
 * esgotou as chamadas à ação. Os restantes marcadores são removidos.
 * Um link do Cal.com escrito diretamente pelo agente também conta.
 */
/**
 * Marcador da CTA, com texto opcional: "[[MARCAR]]" (texto por omissão,
 * cal.textoLink) ou "[[MARCAR|texto]]", que o calParaMarcador cria quando o
 * agente escreveu o seu próprio link do Cal.com, para a frase dele continuar
 * a fazer sentido ("pode [marcar um horário](…)").
 */
function regexMarcador(cfg) {
  const base = cfg.marcadorCta.slice(0, -2).replace(/[[\]|]/g, '\\$&');
  return new RegExp(base + '(?:\\|([^\\]\\n]{1,80}))?\\]\\]', 'g');
}

function aplicarCta(texto, ctx, cfg) {
  const anteriores = (ctx && ctx.ctasAnteriores) || 0;
  const podeUsar = anteriores < cfg.limites.ctasMaxPorConversa;
  let usada = false;

  let t = String(texto).replace(regexMarcador(cfg), (m, rotulo) => {
    if (!podeUsar || usada) return '';
    usada = true;
    const url = urlCal(ctx && ctx.nome, ctx && ctx.email, cfg);
    return `[${(rotulo || '').trim() || cfg.cal.textoLink}](${url})`;
  });

  // Arruma o que sobra de marcadores removidos (bullets vazios, espaços).
  t = t
    .replace(/^[ \t]*[-*•][ \t]*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!usada) usada = t.includes('cal.com/' + contaCal(cfg) + '/');
  return { texto: t, ctaUsada: usada };
}

/**
 * Links do Cal.com escritos pelo agente (a base tem o URL por extenso)
 * passam a marcador: assim levam nome e email pré-preenchidos, contam para
 * o máximo de chamadas à ação e são removidos se esse máximo já foi usado.
 */
function calParaMarcador(texto, cfg) {
  const conta = contaCal(cfg).replace(/[^a-z0-9-]/gi, '');
  const url = 'https?://(?:app\\.)?cal\\.com/' + conta + '(?:/[^\\s)\\]]*)?';
  return String(texto)
    .replace(new RegExp('\\[([^\\]\\n|]*)\\]\\(\\s*<?' + url + '>?\\s*\\)', 'g'), (m, rotulo) => {
      const r = rotulo.trim();
      return r ? cfg.marcadorCta.slice(0, -2) + '|' + r + ']]' : cfg.marcadorCta;
    })
    .replace(new RegExp('(?<![\\w/])' + url, 'g'), (m) => {
      const final = (m.match(/[.,;:!?'"»]+$/) || [''])[0];
      return cfg.marcadorCta + final;
    });
}

/**
 * URLs soltos (já filtrados pela allowlist) passam a links Markdown: o
 * widget não torna URLs soltos clicáveis.
 */
function tornarClicaveis(texto) {
  const guardados = [];
  let t = String(texto).replace(/\[[^\]\n]*\]\([^)\s]+\)/g, (m) => {
    guardados.push(m);
    return '\u0000' + (guardados.length - 1) + '\u0000';
  });
  t = t.replace(/\b(?:https:\/\/|www\.)[^\s<>()[\]\u0000]+/gi, (m) => {
    const final = (m.match(/[.,;:!?'"»]+$/) || [''])[0];
    const url = m.slice(0, m.length - final.length);
    const href = /^www\./i.test(url) ? 'https://' + url : url;
    const rotulo = href.replace(/^https:\/\/(www\.)?/i, '').replace(/\/$/, '');
    return '[' + rotulo + '](' + href + ')' + final;
  });
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => guardados[Number(i)]);
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
/**
 * A marca escreve-se "Náutica". O título "Sobre a Nautica" da base e os
 * domínios não levam acento, e o modelo copia-os. Só toca na palavra com
 * maiúscula e solta, por isso os URLs (em minúsculas) ficam intactos.
 */
function grafiaMarca(texto) {
  return String(texto || '').replace(/(?<![\w./@-])Nautica(?![\w-])/g, 'Náutica');
}

function posProcessar(texto, ctx, cfg) {
  const links = filtrarLinks(grafiaMarca(texto), cfg);
  const comMarcador = calParaMarcador(links.texto, cfg);
  const corte = cortarResposta(comMarcador, cfg.limites.respostaMaxChars);
  const cta = aplicarCta(corte.texto, ctx, cfg);
  const final = tornarClicaveis(cta.texto);
  const ptBr = detetarPtBr(final);
  return {
    texto: final,
    vazia: !final,
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
  calParaMarcador,
  tornarClicaveis,
  detetarPtBr,
  grafiaMarca,
  posProcessar,
};
