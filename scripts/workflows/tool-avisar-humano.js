/**
 * tool-avisar-humano — sub-workflow chamado pelo agente (tool avisar_humano)
 * e pelo tool-registar-lead (aviso automático de lead com contacto).
 *
 * Duas fases no mesmo workflow:
 *
 * 1. Registar (chamada normal): grava o aviso em "handoffs", responde logo
 *    a quem chamou e agenda a fase 2, chamando-se a si próprio sem esperar.
 *    Idempotente por (session_id, motivo): a mesma conversa só gera outro
 *    aviso se o motivo mudar (as repetidas contam em "repeticoes").
 *
 * 2. Enviar (entrada com handoff_id): espera uns segundos, relê o aviso e o
 *    lead e só então envia para o canal de leads do Discord.
 *
 * Porquê a espera: quando o visitante pede uma pessoa e deixa o email na
 * mesma mensagem, o agente chama avisar_humano e registar_lead no mesmo
 * passo, e o n8n corre a primeira até ao fim antes da segunda. Lido logo,
 * o aviso saía "sem contacto" e os leads de teste chegavam ao Discord.
 */
const L = require('../lib');

const NOME = 'Chatbot – tool-avisar-humano';
const ESPERA_ENVIO_S = 10;

module.exports = {
  nome: NOME,
  ordem: 10,
  ficheiro: 'tool-avisar-humano.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const entrada = w.no('[TRIGGER] Chamada do agente', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, {
      inputSource: 'workflowInputs',
      // origem: 'agente' (tool do chat-core) ou 'automatico' (tool-registar-lead).
      // handoff_id: só na fase de envio, quando o workflow se chama a si próprio.
      workflowInputs: { values: ['session_id', 'motivo', 'resumo', 'origem', 'handoff_id'].map((name) => ({ name, type: 'string' })) },
    }, [0, 0]);

    const fase = w.no('[GUARD] Fase de envio?', 'n8n-nodes-base.if', 2.2, L.paramsSe('Boolean($json.handoff_id)'), [220, 0]);

    // --- Fase 1: registar e responder -----------------------------------
    const validar = w.no('[GUARD] Validar pedido', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas', 'validacoes'], `
const e = $input.first().json;
if (!validarSessionId(e.session_id)) return [{ json: { valido: false } }];
return [{
  json: {
    valido: true,
    session_id: e.session_id,
    motivo: validarMotivo(e.motivo, CONFIG, e.origem),
    resumo: limparCampo(e.resumo, LIMITES_CAMPOS_LEAD.resumo) || '(sem resumo)',
  },
}];
`),
    }, [440, 200]);

    const sessaoOk = w.no('[GUARD] Sessão válida?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.valido'), [660, 200]);

    const registar = w.no('[TOOL] Registar aviso', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
SELECT h.handoff_id, h.enviar, h.teste
FROM (SELECT $1::jsonb AS p) AS x
CROSS JOIN LATERAL registar_handoff(p->>'session_id', p->>'motivo', p->>'resumo') AS h
`, 'JSON.stringify({ session_id: $json.session_id, motivo: $json.motivo, resumo: $json.resumo })'),
    [880, 100], { credentials: L.CRED_PG, ...L.RETRY_PG });

    const primeiro = w.no('[TOOL] Primeiro aviso deste motivo?', 'n8n-nodes-base.if', 2.2,
      L.paramsSe('$json.enviar'), [1100, 100]);

    const agendar = w.no('[TOOL] Agendar envio', 'n8n-nodes-base.executeWorkflow', 1.2, {
      source: 'database',
      workflowId: L.refWorkflow(NOME),
      workflowInputs: L.entradas({
        session_id: "={{ $('[GUARD] Validar pedido').first().json.session_id }}",
        motivo: '',
        resumo: '',
        origem: 'envio',
        handoff_id: '={{ String($json.handoff_id) }}',
      }),
      mode: 'once',
      options: { waitForSubWorkflow: false },
    }, [1320, 0], { onError: 'continueRegularOutput' });

    const resposta = w.no('[OUTPUT] Resposta ao agente', 'n8n-nodes-base.code', 2, {
      jsCode: `
const v = $('[GUARD] Validar pedido').first().json;
if (!v.valido) return [{ json: { resposta: 'Não foi possível registar o pedido desta conversa.' } }];
const r = $('[TOOL] Registar aviso').first().json;
// Conversa de teste: o aviso fica registado mas não vai para o Discord; para o
// agente (e para os evals) a resposta é a mesma de um aviso enviado.
const novo = r.enviar || r.teste;
return [{
  json: {
    resposta: novo
      ? 'Pedido registado: a equipa da Náutica foi avisada e vai dar seguimento.'
      : 'A equipa já tinha sido avisada sobre esta conversa com o mesmo motivo; não é preciso voltar a avisar.',
  },
}];
`,
    }, [1540, 200]);

    // --- Fase 2: esperar, reler e enviar --------------------------------
    const esperar = w.no('[GUARD] Esperar pelo registar_lead', 'n8n-nodes-base.wait', 1.1, {
      resume: 'timeInterval',
      amount: ESPERA_ENVIO_S,
      unit: 'seconds',
    }, [440, -200]);

    // Só avisos ainda pendentes (nunca envia duas vezes). Liga o aviso ao
    // lead e, se o lead for de teste, marca-o "teste" em vez de enviar.
    const reler = w.no('[TOOL] Reler aviso e lead', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
WITH u AS (
  UPDATE handoffs h SET
    lead_id = coalesce((SELECT l.id FROM leads l WHERE l.session_id = h.session_id), h.lead_id),
    crm_existente = coalesce((SELECT l.crm_existente FROM leads l WHERE l.session_id = h.session_id), h.crm_existente),
    discord_estado = CASE
      WHEN (SELECT l.sync_estado FROM leads l WHERE l.session_id = h.session_id) = 'teste' THEN 'teste'
      ELSE h.discord_estado END
  WHERE h.id = ($1::jsonb->>'handoff_id')::bigint AND h.discord_estado = 'pendente'
  RETURNING h.id AS handoff_id, h.session_id, h.motivo, h.resumo, h.discord_estado = 'teste' AS teste
)
SELECT u.*, l.nome, l.empresa, l.setor, l.email, l.telefone, l.problema, l.notion_page_id,
       coalesce(l.crm_existente, false) AS crm_existente,
       coalesce(l.crm_paginas, '[]'::jsonb) AS crm_paginas
FROM u LEFT JOIN leads l ON l.session_id = u.session_id
`, "JSON.stringify({ handoff_id: $('[TRIGGER] Chamada do agente').first().json.handoff_id })"),
    [660, -200], { credentials: L.CRED_PG, ...L.RETRY_PG });

    const real = w.no('[GUARD] Conversa real?', 'n8n-nodes-base.if', 2.2, L.paramsSe('!$json.teste'), [880, -200]);

    const mensagem = w.no('[NORMALIZE] Mensagem para o Discord', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['mensagens'], `
const h = $input.first().json;
return [{ json: { handoff_id: h.handoff_id, mensagem: mensagemHandoff(h) } }];
`),
    }, [1100, -300]);

    const d = L.paramsDiscord('$json.mensagem', 'Discord chatbot leads');
    const discord = w.no('[OUTPUT] Discord – leads', 'n8n-nodes-base.discord', 2, d.parametros, [1320, -300], d.extra);

    // Um aviso que não chegou ao Discord é um lead que ninguém vê: alerta.
    const falhou = w.no('[GUARD] O Discord recusou?', 'n8n-nodes-base.if', 2.2, L.paramsSe('Boolean($json.error)'), [1540, -300]);
    const eDiscord = L.paramsRegistarErro('[OUTPUT] Discord – leads', 'aviso_nao_enviado',
      "'handoff ' + $('[NORMALIZE] Mensagem para o Discord').first().json.handoff_id + ': ' + String($json.error.message || $json.error)");
    const erroDiscord = w.no('[ERROR] Aviso não chegou ao Discord', 'n8n-nodes-base.executeWorkflow', 1.2,
      eDiscord.parametros, [1760, -400], eDiscord.extra);

    const estado = w.no('[LOGGING] Estado do envio', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
UPDATE handoffs SET
  discord_estado = CASE WHEN (p->>'ok')::boolean THEN 'enviado' ELSE 'falhado' END,
  discord_erro   = left(p->>'erro', 500),
  enviado_em     = CASE WHEN (p->>'ok')::boolean THEN now() END
FROM (SELECT $1::jsonb AS p) AS x
WHERE handoffs.id = (p->>'handoff_id')::bigint
RETURNING handoffs.id, handoffs.discord_estado
`, `JSON.stringify({
  handoff_id: $('[NORMALIZE] Mensagem para o Discord').first().json.handoff_id,
  ok: !$json.error,
  erro: $json.error ? String($json.error.message || JSON.stringify($json.error)) : null,
})`), [1980, -300], { credentials: L.CRED_PG });

    w.liga(entrada, fase);
    w.liga(fase, esperar, 0);
    w.liga(fase, validar, 1);

    w.liga(validar, sessaoOk);
    w.liga(sessaoOk, registar, 0);
    w.liga(sessaoOk, resposta, 1);
    w.liga(registar, primeiro);
    w.liga(primeiro, agendar, 0);
    w.liga(primeiro, resposta, 1);
    w.liga(agendar, resposta);

    w.liga(esperar, reler);
    w.liga(reler, real);
    w.liga(real, mensagem, 0);
    w.liga(mensagem, discord);
    w.liga(discord, falhou);
    w.liga(falhou, erroDiscord, 0);
    w.liga(falhou, estado, 1);
    w.liga(erroDiscord, estado);

    return w.json();
  },
};
