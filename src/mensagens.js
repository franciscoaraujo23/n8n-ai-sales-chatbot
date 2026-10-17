/**
 * Mensagens para o Discord (leads e alertas internos).
 *
 * Texto vindo do visitante é neutralizado: um "@everyone" escrito no chat
 * não pode notificar o canal inteiro. O Discord corta acima de 2000
 * caracteres, por isso tudo é limitado aqui.
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 */

const LIMITE_DISCORD = 2000;

const ROTULOS_MOTIVO = {
  lead_qualificado: 'Lead qualificado',
  pede_humano: 'Pede para falar com uma pessoa',
  reclamacao: 'Reclamação',
  outro: 'Outro',
};

/** Neutraliza menções e marcação que o visitante possa ter escrito. */
function semMencoes(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<(@[!&]?|#)(\d+)>/g, '<$1​$2>')
    .replace(/```/g, "'''");
}

function cortar(texto, max) {
  const t = String(texto);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Aviso de handoff para o canal de leads.
 * `dados`: { motivo, resumo, session_id, nome, empresa, setor, email,
 *            telefone, problema, crm_existente, crm_paginas, notion_page_id }
 */
function mensagemHandoff(dados) {
  const d = dados || {};
  const linhas = [`**Chatbot do site — ${ROTULOS_MOTIVO[d.motivo] || ROTULOS_MOTIVO.outro}**`];

  const quem = [d.nome, d.empresa, d.setor].filter(Boolean).map(semMencoes).join(' · ');
  if (quem) linhas.push(quem);
  const contacto = [d.email, d.telefone].filter(Boolean).map(semMencoes).join(' · ');
  linhas.push(contacto ? `Contacto: ${contacto}` : 'Contacto: ainda não deixou');

  if (d.crm_existente) {
    const paginas = (d.crm_paginas || []).map((p) => `${p.crm} (<${p.url}>)`).join(', ');
    linhas.push(`⚠️ Já existe no CRM dos comerciais: ${paginas || 'sim'}`);
  }
  if (d.problema) linhas.push(`**Problema:** ${cortar(semMencoes(d.problema), 400)}`);

  const rodape = [];
  if (d.notion_page_id) rodape.push(`Notion: <https://www.notion.so/${String(d.notion_page_id).replace(/-/g, '')}>`);
  rodape.push(`Sessão: ${semMencoes(d.session_id)}`);

  const fixo = linhas.join('\n') + '\n**Resumo:** ' + '\n' + rodape.join(' · ');
  const espaco = LIMITE_DISCORD - fixo.length;
  const resumo = cortar(semMencoes(d.resumo || '(sem resumo)'), Math.max(espaco, 50));

  return cortar([...linhas, `**Resumo:** ${resumo}`, rodape.join(' · ')].join('\n'), LIMITE_DISCORD);
}

/** Alerta de base de conhecimento inválida (canal de erros). */
function mensagemKbInvalida(erros, hash) {
  const lista = (erros || []).map((e) => `• ${e}`).join('\n');
  return cortar(
    '**kb-sync: a versão nova da base de conhecimento NÃO foi ativada.**\n' +
      'O bot continua com a versão anterior. Corrigir o Google Doc:\n' +
      lista +
      `\n(hash ${String(hash || '').slice(0, 12)})`,
    LIMITE_DISCORD
  );
}

// --- o build corta a partir daqui ---
module.exports = { LIMITE_DISCORD, ROTULOS_MOTIVO, semMencoes, mensagemHandoff, mensagemKbInvalida };
