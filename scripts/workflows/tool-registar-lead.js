/**
 * tool-registar-lead — sub-workflow chamado pelo agente (tool registar_lead)
 * e, de 5 em 5 minutos, para novas tentativas de sincronização.
 *
 * Camada 1 (Postgres): valida e grava sempre o lead (upsert por session_id).
 * Camada 2 (Notion): só com contacto válido. Consulta os CRMs dos
 * comerciais em SÓ LEITURA, procura a pessoa na base "Chatbot site" e
 * atualiza a página existente ou cria uma nova. Falhas ficam pendentes no
 * Postgres com backoff; o agente (e o visitante) nunca as vê.
 */
const L = require('../lib');

const NOME = 'Chatbot – tool-registar-lead';

module.exports = {
  nome: NOME,
  ordem: 10,
  ficheiro: 'tool-registar-lead.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    // --- Entrada pela tool ------------------------------------------------
    const entrada = w.no('[TRIGGER] Chamada do agente', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: ['session_id', 'nome', 'empresa', 'setor', 'problema', 'email', 'telefone', 'resumo'].map((name) => ({
          name,
          type: 'string',
        })),
      },
    }, [0, 0]);

    const validar = w.no('[GUARD] Validar lead', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas', 'validacoes'], `
const e = $input.first().json;
if (!validarSessionId(e.session_id)) {
  return [{ json: { valido: false, motivo: 'sessao_invalida' } }];
}
const r = validarLead(e);
return [{ json: { valido: true, session_id: e.session_id, ...r } }];
`),
    }, [220, 0]);

    const sessaoOk = w.no('[GUARD] Sessão válida?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.valido'), [440, 0]);

    const gravar = w.no('[TOOL] Gravar lead (Postgres)', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT * FROM registar_lead($1::jsonb)',
        'JSON.stringify({ session_id: $json.session_id, ...$json.lead })'),
      [660, -100], { credentials: L.CRED_PG });

    const temContacto = w.no('[TOOL] Tem contacto?', 'n8n-nodes-base.if', 2.2,
      L.paramsSe("$json.sync_estado === 'pendente'"), [880, -100]);

    const reservarUm = w.no('[TOOL] Reservar este lead', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT * FROM reservar_leads_sync(($1::jsonb)->>0, 1)', 'JSON.stringify([$json.session_id])'),
      [1100, -200], { credentials: L.CRED_PG, alwaysOutputData: true });

    // --- Entrada pelas novas tentativas -----------------------------------
    const agenda = w.no('[TRIGGER] Novas tentativas (5 min)', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] },
    }, [880, 200]);

    const reservarVarios = w.no('[TOOL] Reservar pendentes', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT * FROM reservar_leads_sync(NULL, 10)'),
      [1100, 200], { credentials: L.CRED_PG, alwaysOutputData: true });

    // --- Sincronização (comum às duas entradas) ---------------------------
    const haLead = w.no('[TOOL] Há lead para sincronizar?', 'n8n-nodes-base.if', 2.2,
      L.paramsSe('Boolean($json.id)'), [1320, 0]);

    const preparar = w.no('[NORMALIZE] Preparar procura', 'n8n-nodes-base.code', 2, {
      mode: 'runOnceForEachItem',
      jsCode: L.codigo(['config', 'notion'], `
// Uma consulta por CRM dos comerciais (só leitura) e uma à base do bot.
const lead = $json;
const contacto = { email: lead.email, telefone: lead.telefone };
return {
  json: {
    lead,
    consultas: CONFIG.notion.crms.map((c) => ({
      crm: c.nome,
      url: 'https://api.notion.com/v1/databases/' + c.id + '/query',
      corpo: consultaContacto(contacto, c.tipoTelefone),
    })),
    urlChatbot: 'https://api.notion.com/v1/databases/' + CONFIG.notion.chatbotSite + '/query',
    corpoChatbot: consultaContacto(contacto, 'phone_number'),
  },
};
`),
    }, [1540, -100]);

    // A ordem destes dois nós segue CONFIG.notion.crms (índices 0 e 1).
    const crm0 = L.paramsNotion('POST',
      "={{ $('[NORMALIZE] Preparar procura').item.json.consultas[0].url }}",
      "={{ JSON.stringify($('[NORMALIZE] Preparar procura').item.json.consultas[0].corpo) }}",
      'Notion CRM leitura');
    const procurarCrm0 = w.no('[TOOL] Procurar em Clientes Site (só leitura)', 'n8n-nodes-base.httpRequest', 4.2,
      crm0.parametros, [1760, -100], crm0.extra);

    const crm1 = L.paramsNotion('POST',
      "={{ $('[NORMALIZE] Preparar procura').item.json.consultas[1].url }}",
      "={{ JSON.stringify($('[NORMALIZE] Preparar procura').item.json.consultas[1].corpo) }}",
      'Notion CRM leitura');
    const procurarCrm1 = w.no('[TOOL] Procurar em CRM Nautica AI (só leitura)', 'n8n-nodes-base.httpRequest', 4.2,
      crm1.parametros, [1980, -100], crm1.extra);

    const chat = L.paramsNotion('POST',
      "={{ $('[NORMALIZE] Preparar procura').item.json.urlChatbot }}",
      "={{ JSON.stringify($('[NORMALIZE] Preparar procura').item.json.corpoChatbot) }}",
      'Notion chatbot');
    const procurarChatbot = w.no('[TOOL] Procurar no Chatbot site', 'n8n-nodes-base.httpRequest', 4.2,
      chat.parametros, [2200, -100], chat.extra);

    const montar = w.no('[NORMALIZE] Montar página', 'n8n-nodes-base.code', 2, {
      mode: 'runOnceForEachItem',
      jsCode: L.codigo(['config', 'notion'], `
const prep = $('[NORMALIZE] Preparar procura').item.json;
const respostas = [
  { crm: prep.consultas[0].crm, resposta: $('[TOOL] Procurar em Clientes Site (só leitura)').item.json },
  { crm: prep.consultas[1].crm, resposta: $('[TOOL] Procurar em CRM Nautica AI (só leitura)').item.json },
];
const crm = resumirCrms(respostas);

// Página já conhecida no Postgres; senão, a encontrada pelo email/telefone.
const paginaId = prep.lead.notion_page_id || primeiraPagina($('[TOOL] Procurar no Chatbot site').item.json);
return { json: { lead_id: prep.lead.id, crm, pedido: pedidoGravarLead(prep.lead, paginaId, crm, CONFIG) } };
`),
    }, [2420, -100]);

    const gravarNotionP = L.paramsNotion('={{ $json.pedido.metodo }}', '={{ $json.pedido.url }}',
      '={{ JSON.stringify($json.pedido.corpo) }}', 'Notion chatbot');
    const gravarNotion = w.no('[TOOL] Gravar no Chatbot site', 'n8n-nodes-base.httpRequest', 4.2,
      gravarNotionP.parametros, [2640, -100], gravarNotionP.extra);

    const resultado = w.no('[NORMALIZE] Resultado da sync', 'n8n-nodes-base.code', 2, {
      mode: 'runOnceForEachItem',
      jsCode: L.codigo(['notion'], `
const m = $('[NORMALIZE] Montar página').item.json;
const r = $json;
const erro = erroNotion(r) || (r.id ? null : 'resposta do Notion sem id');
return {
  json: {
    id: m.lead_id,
    ok: !erro,
    notion_page_id: erro ? null : r.id,
    crm_existente: m.crm.crm_existente,
    crm_paginas: m.crm.crm_paginas,
    erro,
  },
};
`),
    }, [2860, -100]);

    const concluir = w.no('[LOGGING] Concluir sync', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT id, sync_estado, sync_tentativas FROM concluir_sync_lead($1::jsonb)', 'JSON.stringify($json)'),
      [3080, -100], { credentials: L.CRED_PG });

    // --- Resposta ao agente (curta; nunca menciona erros do Notion) -------
    const resposta = w.no('[OUTPUT] Resposta ao agente', 'n8n-nodes-base.code', 2, {
      jsCode: `
// Só faz sentido na chamada da tool; nas novas tentativas agendadas o
// nó de validação não correu e a resposta é ignorada.
let v;
try { v = $('[GUARD] Validar lead').first().json; } catch (e) { return [{ json: { resposta: 'ok' } }]; }
if (!v.valido) return [{ json: { resposta: 'Não foi possível guardar os dados desta conversa.' } }];

let estado = null;
try { estado = $('[TOOL] Gravar lead (Postgres)').first().json.sync_estado; } catch (e) { /* sem gravação */ }

const partes = ['Dados do visitante guardados.'];
if (v.avisos.includes('email_invalido')) partes.push('O email indicado não parece válido: confirme-o com o visitante.');
if (v.avisos.includes('telefone_invalido')) partes.push('O telefone indicado não parece válido: confirme-o com o visitante.');
if (estado === 'sem_contacto') partes.push('Ainda não há email nem telefone válidos: sem um deles, a equipa não consegue responder.');
return [{ json: { resposta: partes.join(' ') } }];
`,
    }, [3300, 0]);

    w.liga(entrada, validar);
    w.liga(validar, sessaoOk);
    w.liga(sessaoOk, gravar, 0);
    w.liga(sessaoOk, resposta, 1);
    w.liga(gravar, temContacto);
    w.liga(temContacto, reservarUm, 0);
    w.liga(temContacto, resposta, 1);
    w.liga(reservarUm, haLead);
    w.liga(agenda, reservarVarios);
    w.liga(reservarVarios, haLead);
    w.liga(haLead, preparar, 0);
    w.liga(haLead, resposta, 1);
    w.liga(preparar, procurarCrm0);
    w.liga(procurarCrm0, procurarCrm1);
    w.liga(procurarCrm1, procurarChatbot);
    w.liga(procurarChatbot, montar);
    w.liga(montar, gravarNotion);
    w.liga(gravarNotion, resultado);
    w.liga(resultado, concluir);
    w.liga(concluir, resposta);

    return w.json();
  },
};
