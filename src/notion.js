/**
 * Corpos dos pedidos à API do Notion (versão 2022-06-28) para a
 * sincronização de leads: procura nos CRMs (só leitura) e criação ou
 * atualização da página na base "Chatbot site".
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 */

/** Rich text do Notion: blocos de até 2000 caracteres (limite da API). */
function textoNotion(valor) {
  const s = valor === null || valor === undefined ? '' : String(valor);
  const blocos = [];
  for (let i = 0; i < s.length && blocos.length < 100; i += 2000) {
    blocos.push({ type: 'text', text: { content: s.slice(i, i + 2000) } });
  }
  return blocos;
}

/**
 * Filtro "email igual OU telefone contém". O telefone compara-se pelos
 * últimos 9 dígitos: nos CRMs aparece como "912345678", "+351912345678"
 * e até "++351912345678".
 */
function filtroContacto(contacto, tipoTelefone) {
  const ou = [];
  if (contacto.email) ou.push({ property: 'Email', email: { equals: contacto.email } });
  const digitos = String(contacto.telefone || '').replace(/\D/g, '');
  if (digitos.length >= 9) {
    ou.push({ property: 'Telefone', [tipoTelefone]: { contains: digitos.slice(-9) } });
  }
  if (!ou.length) return null;
  return ou.length === 1 ? ou[0] : { or: ou };
}

/** Corpo de um POST /v1/databases/{id}/query. */
function consultaContacto(contacto, tipoTelefone) {
  const filtro = filtroContacto(contacto, tipoTelefone);
  return filtro ? { filter: filtro, page_size: 5 } : null;
}

function urlNotion(id) {
  return 'https://www.notion.so/' + String(id).replace(/-/g, '');
}

/**
 * Junta as respostas das consultas aos CRMs. Uma consulta que falhou fica
 * como "desconhecido" (null) e não apaga o que já se sabia.
 */
function resumirCrms(respostas) {
  let algumaOk = false;
  const paginas = [];
  for (const r of respostas) {
    if (!r || !r.resposta || r.resposta.error || !Array.isArray(r.resposta.results)) continue;
    algumaOk = true;
    for (const p of r.resposta.results) paginas.push({ crm: r.crm, url: p.url || urlNotion(p.id) });
  }
  return {
    crm_existente: algumaOk ? paginas.length > 0 : null,
    crm_paginas: algumaOk ? paginas : null,
  };
}

/** Primeira página encontrada numa resposta de query, ou null. */
function primeiraPagina(resposta) {
  if (!resposta || resposta.error || !Array.isArray(resposta.results) || !resposta.results.length) return null;
  return resposta.results[0].id;
}

/**
 * Propriedades da página em "Chatbot site". Só envia campos com valor,
 * para nunca apagar o que alguém escreveu à mão. Origem e Estado só na
 * criação: depois, o Estado é da equipa.
 */
function propriedadesLead(lead, opcoes) {
  const o = opcoes || {};
  const props = {
    Nome: { title: textoNotion(lead.nome || lead.email || lead.telefone || 'Visitante do chat') },
    'Sessão': { rich_text: textoNotion(lead.session_id) },
  };
  const texto = { Empresa: lead.empresa, Setor: lead.setor, Problema: lead.problema, 'Resumo da conversa': lead.resumo };
  for (const [nome, valor] of Object.entries(texto)) {
    if (valor) props[nome] = { rich_text: textoNotion(valor) };
  }
  if (lead.email) props.Email = { email: lead.email };
  if (lead.telefone) props.Telefone = { phone_number: lead.telefone };
  if (o.crm && o.crm.crm_existente !== null && o.crm.crm_existente !== undefined) {
    props['Já no CRM'] = { checkbox: o.crm.crm_existente };
    const primeira = (o.crm.crm_paginas || [])[0];
    if (primeira) props['Página no CRM'] = { url: primeira.url };
  }
  if (o.criar) {
    props.Origem = { select: { name: 'Chatbot' } };
    props.Estado = { select: { name: 'Novo' } };
  }
  return props;
}

/**
 * Pedido de escrita: PATCH da página existente ou POST de uma nova.
 * Devolve { metodo, url, corpo }.
 */
function pedidoGravarLead(lead, paginaId, crm, cfg) {
  if (paginaId) {
    return {
      metodo: 'PATCH',
      url: 'https://api.notion.com/v1/pages/' + paginaId,
      corpo: { properties: propriedadesLead(lead, { crm, criar: false }) },
    };
  }
  return {
    metodo: 'POST',
    url: 'https://api.notion.com/v1/pages',
    corpo: {
      parent: { database_id: cfg.notion.chatbotSite },
      properties: propriedadesLead(lead, { crm, criar: true }),
    },
  };
}

/** Mensagem curta de um erro devolvido pelo nó HTTP (para sync_ultimo_erro). */
function erroNotion(resposta) {
  if (!resposta) return 'sem resposta';
  if (resposta.error) {
    const e = resposta.error;
    return String(e.message || e.description || JSON.stringify(e)).slice(0, 500);
  }
  if (resposta.object === 'error') return `${resposta.status || ''} ${resposta.code || ''}: ${resposta.message || ''}`.trim();
  return null;
}

// --- o build corta a partir daqui ---
module.exports = {
  textoNotion,
  filtroContacto,
  consultaContacto,
  urlNotion,
  resumirCrms,
  primeiraPagina,
  propriedadesLead,
  pedidoGravarLead,
  erroNotion,
};
