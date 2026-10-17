/**
 * error-handler — grava todos os erros do chatbot no Postgres e alerta no
 * canal de erros do Discord, no máximo uma vez por workflow em cada 5
 * minutos (anti-spam em registar_erro).
 *
 * Duas entradas:
 *  - Error Trigger: é o errorWorkflow de todos os workflows do chatbot;
 *  - registar-erro: chamado pelos outros workflows quando tratam um erro
 *    para o visitante não o ver, mas ele tem de ficar visível para a equipa
 *    (falha a gravar o turno, aviso que o Discord recusou, lead que não
 *    chegou ao Notion, agente que falhou, base de conhecimento em falta).
 *
 * O alerta não inclui a mensagem de erro (pode ter texto de visitantes).
 */
const L = require('../lib');

const NOME = L.ERROR_HANDLER;
const JANELA_MINUTOS = 5;

module.exports = {
  nome: NOME,
  ordem: 0,
  ficheiro: 'error-handler.json',
  criar() {
    // Sem errorWorkflow: um erro aqui não pode chamar-se a si próprio.
    const w = L.workflow(NOME, L.settingsBase({ errorWorkflow: null }));

    const trigger = w.no('[TRIGGER] Erro de workflow', 'n8n-nodes-base.errorTrigger', 1, {}, [0, -100]);

    const chamada = w.no('[TRIGGER] Registar erro (chamada)', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: ['workflow_id', 'workflow_nome', 'no', 'tipo', 'mensagem', 'execution_id'].map((name) => ({
          name,
          type: 'string',
        })),
      },
    }, [0, 100]);

    const normTrigger = w.no('[NORMALIZE] Erro do trigger', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['erros'], `
return [{ json: normalizarErroTrigger($input.first().json) }];
`),
    }, [220, -100]);

    const normChamada = w.no('[NORMALIZE] Erro registado', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['erros'], `
return [{ json: normalizarErroRegistado($input.first().json) }];
`),
    }, [220, 100]);

    const registar = w.no('[LOGGING] Registar erro', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
SELECT r.erro_id, r.alertar
FROM (SELECT $1::jsonb AS p) AS x
CROSS JOIN LATERAL registar_erro(
  p->>'origem', p->>'workflow_id', p->>'workflow_nome', p->>'no', p->>'tipo',
  p->>'mensagem', p->>'execution_id', p->>'execution_url', ${JANELA_MINUTOS}
) AS r
`, 'JSON.stringify($json)'), [440, 0], { credentials: L.CRED_PG, ...L.RETRY_PG });

    const alertar = w.no('[GUARD] Alertar agora?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.alertar'), [660, 0]);

    const mensagem = w.no('[NORMALIZE] Mensagem de alerta', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['erros'], `
const r = $input.first().json;
// Os dados do erro vêm do nó de normalização que correu (trigger ou chamada).
let erro;
try { erro = $('[NORMALIZE] Erro do trigger').first().json; } catch (e) { erro = $('[NORMALIZE] Erro registado').first().json; }
return [{ json: { erro_id: r.erro_id, mensagem: mensagemErro(erro, r.erro_id, ${JANELA_MINUTOS}) } }];
`),
    }, [880, -100]);

    const d = L.paramsDiscord('$json.mensagem', 'Discord chatbot erros');
    const discord = w.no('[OUTPUT] Discord – erros', 'n8n-nodes-base.discord', 2, d.parametros, [1100, -100], d.extra);

    const enviou = w.no('[GUARD] O Discord aceitou?', 'n8n-nodes-base.if', 2.2, L.paramsSe('!$json.error'), [1320, -100]);

    // Se o alerta não saiu, o próximo erro deste workflow volta a tentar.
    const desmarcar = w.no('[LOGGING] Alerta não enviado', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(
      'UPDATE errors SET alertado = false WHERE id = (($1::jsonb)->>0)::bigint RETURNING id',
      "JSON.stringify([$('[NORMALIZE] Mensagem de alerta').first().json.erro_id])"
    ), [1540, 0], { credentials: L.CRED_PG, onError: 'continueRegularOutput' });

    w.liga(trigger, normTrigger);
    w.liga(chamada, normChamada);
    w.liga(normTrigger, registar);
    w.liga(normChamada, registar);
    w.liga(registar, alertar);
    w.liga(alertar, mensagem, 0);
    w.liga(mensagem, discord);
    w.liga(discord, enviou);
    w.liga(enviou, desmarcar, 1);

    return w.json();
  },
};
