/**
 * tool-avisar-humano — sub-workflow chamado pelo agente (tool avisar_humano).
 *
 * Envia o resumo da conversa para o canal de leads no Discord. Idempotente
 * por (session_id, motivo): a mesma conversa só gera outro aviso se o
 * motivo mudar. Cada chamada fica registada em "handoffs" (as repetidas
 * contam em "repeticoes").
 */
const L = require('../lib');

const NOME = 'Chatbot – tool-avisar-humano';

module.exports = {
  nome: NOME,
  ordem: 10,
  ficheiro: 'tool-avisar-humano.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const entrada = w.no('[TRIGGER] Chamada do agente', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, {
      inputSource: 'workflowInputs',
      // origem: 'agente' (tool do chat-core) ou 'automatico' (tool-registar-lead).
      workflowInputs: { values: ['session_id', 'motivo', 'resumo', 'origem'].map((name) => ({ name, type: 'string' })) },
    }, [0, 0]);

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
    }, [220, 0]);

    const sessaoOk = w.no('[GUARD] Sessão válida?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.valido'), [440, 0]);

    // O agente chama as tools do mesmo passo em paralelo: quem dá o contacto e
    // pede uma pessoa na mesma mensagem dispara registar_lead e avisar_humano
    // ao mesmo tempo, e o aviso lia a conversa antes de o lead estar gravado
    // (saía "sem contacto" e um lead de teste ia para o Discord). Sem contacto
    // gravado, espera um pouco antes de registar; com contacto, segue logo.
    const temContacto = w.no('[GUARD] Contacto já gravado?', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
SELECT EXISTS (
  SELECT 1 FROM leads
  WHERE session_id = $1::jsonb->>'session_id' AND (email IS NOT NULL OR telefone IS NOT NULL)
) AS tem_contacto
`, 'JSON.stringify({ session_id: $json.session_id })'), [660, -100], { credentials: L.CRED_PG, ...L.RETRY_PG });
    const comContacto = w.no('[GUARD] Com contacto?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.tem_contacto'), [880, -100]);
    const esperar = w.no('[GUARD] Esperar pelo registar_lead', 'n8n-nodes-base.wait', 1.1, {
      resume: 'timeInterval',
      amount: 3,
      unit: 'seconds',
    }, [1100, 0]);

    const registar = w.no('[TOOL] Registar aviso', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
SELECT h.handoff_id, h.enviar, h.teste,
       l.nome, l.empresa, l.setor, l.email, l.telefone, l.problema, l.notion_page_id,
       coalesce(l.crm_existente, false) AS crm_existente,
       coalesce(l.crm_paginas, '[]'::jsonb) AS crm_paginas
FROM (SELECT $1::jsonb AS p) AS x
CROSS JOIN LATERAL registar_handoff(p->>'session_id', p->>'motivo', p->>'resumo') AS h
LEFT JOIN leads l ON l.session_id = p->>'session_id'
`, `(({ session_id, motivo, resumo }) => JSON.stringify({ session_id, motivo, resumo }))($('[GUARD] Validar pedido').first().json)`),
    [1320, -100], { credentials: L.CRED_PG });

    const primeiro = w.no('[TOOL] Primeiro aviso deste motivo?', 'n8n-nodes-base.if', 2.2,
      L.paramsSe('$json.enviar'), [1540, -100]);

    const mensagem = w.no('[NORMALIZE] Mensagem para o Discord', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['mensagens'], `
const pedido = $('[GUARD] Validar pedido').first().json;
const h = $input.first().json;
return [{ json: { handoff_id: h.handoff_id, mensagem: mensagemHandoff({ ...h, ...pedido }) } }];
`),
    }, [1760, -200]);

    const d = L.paramsDiscord('$json.mensagem', 'Discord chatbot leads');
    const discord = w.no('[OUTPUT] Discord – leads', 'n8n-nodes-base.discord', 2, d.parametros, [1980, -200], d.extra);

    // Um aviso que não chegou ao Discord é um lead que ninguém vê: alerta.
    const falhou = w.no('[GUARD] O Discord recusou?', 'n8n-nodes-base.if', 2.2, L.paramsSe('Boolean($json.error)'), [2200, -200]);
    const eDiscord = L.paramsRegistarErro('[OUTPUT] Discord – leads', 'aviso_nao_enviado',
      "'handoff ' + $('[NORMALIZE] Mensagem para o Discord').first().json.handoff_id + ': ' + String($json.error.message || $json.error)");
    const erroDiscord = w.no('[ERROR] Aviso não chegou ao Discord', 'n8n-nodes-base.executeWorkflow', 1.2,
      eDiscord.parametros, [2420, -300], eDiscord.extra);

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
})`), [2640, -200], { credentials: L.CRED_PG });

    const resposta = w.no('[OUTPUT] Resposta ao agente', 'n8n-nodes-base.code', 2, {
      jsCode: `
const v = $('[GUARD] Validar pedido').first().json;
if (!v.valido) return [{ json: { resposta: 'Não foi possível registar o pedido desta conversa.' } }];
const r = $('[TOOL] Registar aviso').first().json;
// Conversa de teste: o aviso fica registado mas não vai para o Discord; para o
// agente (e para os evals) a resposta é a mesma de um aviso enviado.
const enviar = r.enviar || r.teste;
return [{
  json: {
    resposta: enviar
      ? 'Pedido registado: a equipa da Nautica foi avisada e vai dar seguimento.'
      : 'A equipa já tinha sido avisada sobre esta conversa com o mesmo motivo; não é preciso voltar a avisar.',
  },
}];
`,
    }, [2860, 0]);

    w.liga(entrada, validar);
    w.liga(validar, sessaoOk);
    w.liga(sessaoOk, temContacto, 0);
    w.liga(sessaoOk, resposta, 1);
    w.liga(temContacto, comContacto);
    w.liga(comContacto, registar, 0);
    w.liga(comContacto, esperar, 1);
    w.liga(esperar, registar);
    w.liga(registar, primeiro);
    w.liga(primeiro, mensagem, 0);
    w.liga(primeiro, resposta, 1);
    w.liga(mensagem, discord);
    w.liga(discord, falhou);
    w.liga(falhou, erroDiscord, 0);
    w.liga(falhou, estado, 1);
    w.liga(erroDiscord, estado);
    w.liga(estado, resposta);

    return w.json();
  },
};
