/**
 * chat-eval — adaptador para os evals (evals/correr.js).
 *
 * Webhook protegido por cabeçalho (credencial "Eval chatbot"). Chama o
 * núcleo diretamente, SEM o guard-trafego: os evals mandam muitas
 * mensagens seguidas. Tudo o resto (quarentena, validação, kill switch de
 * custo) corre no núcleo, igual a produção.
 *
 * Devolve a resposta e o diagnóstico do turno (guarda, tools, CTA, sinais
 * de português do Brasil), para o runner poder verificar cada caso.
 */
const L = require('../lib');

const NOME = 'Chatbot – chat-eval';

module.exports = {
  nome: NOME,
  ordem: 30,
  ficheiro: 'chat-eval.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const trigger = w.no('[TRIGGER] Webhook de eval', 'n8n-nodes-base.webhook', 2, {
      httpMethod: 'POST',
      path: 'chatbot-eval',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: {},
    }, [0, 0], {
      webhookId: L.uuidDe('chatbot/chat-eval/webhook'),
      credentials: L.credencial('httpHeaderAuth', 'Eval chatbot'),
    });

    const normalizar = w.no('[NORMALIZE] Mensagem canónica', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config'], `
const b = $input.first().json.body || {};
return [{
  json: {
    payload: {
      schema_version: CONFIG.schemaVersion,
      canal: 'eval',
      session_id: String(b.session_id ?? '').slice(0, 100),
      texto: typeof b.texto === 'string' ? b.texto : '',
      recebido_em: new Date().toISOString(),
    },
  },
}];
`),
    }, [220, 0]);

    const nucleo = w.no('[AGENT] Núcleo (chat-core)', 'n8n-nodes-base.executeWorkflow', 1.2,
      L.paramsChamarComPayload('Chatbot – chat-core', '$json.payload'),
      [440, 0], { onError: 'continueErrorOutput' });

    const falha = w.no('[OUTPUT] Falha do núcleo', 'n8n-nodes-base.code', 2, {
      jsCode: `
// No eval queremos ver a falha (o site mostraria o fallback).
const e = $input.first().json.error || {};
return [{ json: { erro_nucleo: String(e.message || 'erro desconhecido'), resposta: null } }];
`,
    }, [660, 150]);

    const responder = w.no('[OUTPUT] Responder ao runner', 'n8n-nodes-base.respondToWebhook', 1.4, {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json) }}',
      options: {},
    }, [880, 0]);

    w.liga(trigger, normalizar);
    w.liga(normalizar, nucleo);
    w.liga(nucleo, responder, 0);
    w.liga(nucleo, falha, 1);
    w.liga(falha, responder);

    return w.json();
  },
};
