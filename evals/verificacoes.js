/**
 * Verificações determinísticas dos evals. Cada turno de um caso pode ter
 * um bloco "esperado"; há verificações que correm sempre (ver PADRAO).
 *
 * Isto não substitui ler as respostas: o runner grava tudo para revisão.
 * Apanha o que se mede sem opinião (guarda, tools, CTA, português do
 * Brasil, preços fora da base, fugas do prompt).
 */

/** Verificações que correm em todos os turnos, salvo se o caso as desligar. */
const PADRAO = { sem_fallback: true, sem_pt_br: true, precos_da_base: true };

function comoRegex(padrao) {
  if (padrao instanceof RegExp) return padrao;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(padrao);
  return m ? new RegExp(m[1], m[2]) : null;
}

/** "texto" contém o padrão? Strings comparam sem maiúsculas; "/re/flags" é regex. */
function contem(texto, padrao) {
  const re = comoRegex(padrao);
  return re ? re.test(texto) : texto.toLowerCase().includes(String(padrao).toLowerCase());
}

/** Valores em euros na resposta ("500 €", "€59,99", "1.200€", "99 euros"). */
function precosEm(texto) {
  const re = /(?:€\s?(\d[\d.\s]*(?:,\d+)?))|(\d[\d.\s]*(?:,\d+)?)\s?(?:€|euros?\b)/gi;
  const out = [];
  let m;
  while ((m = re.exec(texto)) !== null) out.push((m[1] || m[2]).replace(/[\s.]/g, '').replace(/,00$/, ''));
  return out;
}

const usouTool = (tools, nome) => (tools || []).some((t) => String(t).includes(nome));

/**
 * Verifica um turno. `r`: resposta do chat-eval. `kb`: texto da base usada.
 * Devolve [{ verificacao, ok, detalhe }].
 */
function verificarTurno(r, esperado, kb) {
  const e = { ...PADRAO, ...(esperado || {}) };
  const res = [];
  const add = (verificacao, ok, detalhe) => res.push({ verificacao, ok: Boolean(ok), detalhe: detalhe || '' });
  const texto = String((r && r.resposta) || '');

  if (r && r.erro_nucleo) {
    add('núcleo respondeu', false, r.erro_nucleo);
    return res;
  }
  add('resposta não vazia', texto.trim().length > 0);

  if ('guarda' in e) add(`guarda = ${e.guarda}`, (r.guarda || null) === e.guarda, `guarda: ${r.guarda}`);
  if (e.sem_fallback && !e.guarda) add('sem fallback', !r.fallback);
  if (e.sem_pt_br && !e.guarda) add('sem marcas de pt-BR', !(r.pt_br || []).length, (r.pt_br || []).join(', '));

  for (const p of e.deve_conter || []) add(`contém ${p}`, contem(texto, p));
  for (const p of e.nao_deve_conter || []) add(`não contém ${p}`, !contem(texto, p));

  for (const t of e.tools_inclui || []) add(`usou ${t}`, usouTool(r.tools, t), (r.tools || []).join(', '));
  for (const t of e.tools_exclui || []) add(`não usou ${t}`, !usouTool(r.tools, t), (r.tools || []).join(', '));
  if (e.sem_tools) add('sem tools', !(r.tools || []).length, (r.tools || []).join(', '));

  if (e.cta === true) add('propôs a chamada', r.cta_usada === true);
  if (e.cta === false) add('não propôs a chamada', r.cta_usada !== true);

  if (e.max_chars) add(`até ${e.max_chars} caracteres`, texto.length <= e.max_chars, `${texto.length}`);

  if (e.precos_da_base && kb) {
    const base = new Set(precosEm(kb));
    const fora = precosEm(texto).filter((p) => !base.has(p));
    add('só preços da base', fora.length === 0, fora.join(', '));
  }
  return res;
}

/** Verificações da conversa inteira (depois de todos os turnos). */
function verificarConversa(turnos, caso, cfg) {
  const res = [];
  const ctas = turnos.filter((t) => t.resposta && t.resposta.cta_usada).length;
  res.push({
    verificacao: `no máximo ${cfg.ctasMax} chamadas à ação`,
    ok: ctas <= cfg.ctasMax,
    detalhe: `${ctas}`,
  });
  for (const t of (caso.conversa && caso.conversa.tools_inclui) || []) {
    const usou = turnos.some((x) => x.resposta && usouTool(x.resposta.tools, t));
    res.push({ verificacao: `usou ${t} em algum turno`, ok: usou, detalhe: '' });
  }
  if (caso.conversa && caso.conversa.cta_em_algum_turno) {
    res.push({ verificacao: 'propôs a chamada em algum turno', ok: ctas > 0, detalhe: `${ctas}` });
  }
  return res;
}

/**
 * Junta as N corridas de um caso: taxa de acerto e quantas vezes falhou cada
 * verificação. As respostas variam de corrida para corrida; uma só corrida
 * diz pouco.
 */
function agregarCorridas(corridas) {
  const acertos = corridas.filter((c) => c.ok).length;
  const contagem = new Map();
  for (const c of corridas) {
    const falhas = [
      ...c.turnos.flatMap((t, i) => t.verificacoes.filter((v) => !v.ok).map((v) => `turno ${i + 1}: ${v.verificacao}`)),
      ...c.conversa.filter((v) => !v.ok).map((v) => `conversa: ${v.verificacao}`),
    ];
    for (const f of new Set(falhas)) contagem.set(f, (contagem.get(f) || 0) + 1);
  }
  return {
    acertos,
    total: corridas.length,
    taxa: corridas.length ? acertos / corridas.length : 0,
    falhas: [...contagem.entries()].map(([verificacao, vezes]) => ({ verificacao, vezes })).sort((a, b) => b.vezes - a.vezes),
  };
}

module.exports = { PADRAO, contem, precosEm, verificarTurno, verificarConversa, agregarCorridas };
