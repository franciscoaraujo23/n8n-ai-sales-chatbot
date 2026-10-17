/**
 * Validação e normalização dos dados que o agente passa às tools
 * (registar_lead e avisar_humano).
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 * Os nomes não podem colidir com os dos outros ficheiros de /src, porque
 * o build pode juntar vários no mesmo Code node.
 */

const LIMITES_CAMPOS_LEAD = {
  nome: 120,
  empresa: 160,
  setor: 120,
  problema: 2000,
  resumo: 4000,
};

/** Texto livre vindo do LLM: sem controlo, espaços arrumados, cortado ao limite. */
function limparCampo(valor, max) {
  if (valor === null || valor === undefined) return null;
  const limpo = String(valor)
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!limpo) return null;
  return limpo.length > max ? limpo.slice(0, max).trim() : limpo;
}

function validarEmail(valor) {
  if (!valor) return { valido: false, email: null };
  const email = String(valor).trim().toLowerCase().replace(/^mailto:/, '');
  const [local, dominio, ...resto] = email.split('@');
  const valido =
    resto.length === 0 &&
    !!local &&
    !!dominio &&
    email.length <= 254 &&
    local.length <= 64 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    !/^\.|\.$|\.\./.test(local) &&
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(dominio);
  return { valido, email: valido ? email : null };
}

/**
 * Normaliza para E.164. Sem indicativo, assume Portugal (+351) quando o
 * número tem 9 dígitos e começa por 2, 3 ou 9.
 */
function normalizarTelefone(valor) {
  if (!valor) return { valido: false, e164: null };
  let s = String(valor).trim().replace(/[\s.\-()/]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!/^\+?\d+$/.test(s)) return { valido: false, e164: null };

  let e164 = null;
  if (s.startsWith('+')) {
    if (s.startsWith('+351')) {
      if (/^\+351[239]\d{8}$/.test(s)) e164 = s;
    } else if (/^\+[1-9]\d{7,14}$/.test(s)) {
      e164 = s;
    }
  } else if (/^[239]\d{8}$/.test(s)) {
    e164 = '+351' + s;
  }
  return { valido: !!e164, e164 };
}

/**
 * Valida o pedido do registar_lead. Campos inválidos ficam a null e
 * são reportados em `avisos`, mas o lead é sempre gravado no Postgres:
 * só a sincronização com o Notion exige um contacto válido.
 */
function validarLead(entrada) {
  const e = entrada || {};
  const avisos = [];
  const email = validarEmail(e.email);
  const telefone = normalizarTelefone(e.telefone);
  if (e.email && !email.valido) avisos.push('email_invalido');
  if (e.telefone && !telefone.valido) avisos.push('telefone_invalido');

  const lead = {
    nome: limparCampo(e.nome, LIMITES_CAMPOS_LEAD.nome),
    empresa: limparCampo(e.empresa, LIMITES_CAMPOS_LEAD.empresa),
    setor: limparCampo(e.setor, LIMITES_CAMPOS_LEAD.setor),
    problema: limparCampo(e.problema, LIMITES_CAMPOS_LEAD.problema),
    resumo: limparCampo(e.resumo, LIMITES_CAMPOS_LEAD.resumo),
    email: email.email,
    telefone: telefone.e164,
  };
  return { lead, contactoValido: email.valido || telefone.valido, avisos };
}

/** Motivo do avisar_humano: enum fechado, para a idempotência funcionar. */
function validarMotivo(motivo, cfg) {
  const m = String(motivo || '').trim().toLowerCase();
  return cfg.motivosHandoff.includes(m) ? m : 'outro';
}

// --- o build corta a partir daqui ---
module.exports = {
  LIMITES_CAMPOS_LEAD,
  limparCampo,
  validarEmail,
  normalizarTelefone,
  validarLead,
  validarMotivo,
};
