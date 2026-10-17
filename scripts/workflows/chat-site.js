/**
 * chat-site — adaptador do widget do site (Chat Trigger em modo Embedded).
 *
 * Só traduz: pedido do widget → payload canónico → guard-trafego →
 * chat-core → { output } para o widget. Qualquer falha devolve uma
 * resposta útil (email e link do Cal.com), nunca um erro.
 *
 * Notas verificadas no código do n8n 2.29.10 (ver DECISIONS.md):
 * - o Chat Trigger só passa o corpo do pedido: não há IP nem cabeçalhos;
 * - Allowed Origins só define o cabeçalho CORS, não recusa pedidos;
 * - em modo Embedded aceita multipart com ficheiros, mesmo com uploads
 *   desligados no widget: por isso a normalização recusa-os.
 */
const L = require('../lib');
const { CONFIG } = require('../../src/config');

const NOME = 'Chatbot – chat-site';
const PAYLOAD = "$('[NORMALIZE] Mensagem canónica').first().json.payload";

module.exports = {
  nome: NOME,
  ordem: 30,
  ficheiro: 'chat-site.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const trigger = w.no('[TRIGGER] Chat do site', '@n8n/n8n-nodes-langchain.chatTrigger', 1.4, {
      public: true,
      mode: 'webhook',
      authentication: 'none',
      availableInChat: false,
      options: {
        allowedOrigins: CONFIG.site.origens.join(','),
        responseMode: 'responseNode',
        loadPreviousSession: 'notSupported',
      },
    // webhookId fixo: define o URL do chat (…/webhook/<id>/chat) que fica no
    // embed do site. Não pode mudar entre envios.
    }, [0, 0], { webhookId: L.uuidDe('chatbot/chat-site/webhook') });

    const normalizar = w.no('[NORMALIZE] Mensagem canónica', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config'], `
const item = $input.first();
const b = item.json || {};
// Só mensagens de texto: ações do widget que não suportamos e ficheiros
// enviados diretamente ao webhook ficam de fora.
const valido = b.action === 'sendMessage' && typeof b.chatInput === 'string' && !item.binary && !b.files;
return [{
  json: {
    valido,
    payload: {
      schema_version: CONFIG.schemaVersion,
      canal: 'site',
      session_id: String(b.sessionId ?? '').slice(0, 100),
      texto: valido ? b.chatInput : '',
      recebido_em: new Date().toISOString(),
    },
  },
}];
`),
    }, [220, 0]);

    const valido = w.no('[GUARD] Mensagem de texto?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.valido'), [440, 0]);

    const invalido = w.no('[OUTPUT] Pedido inválido', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas'], `
return [{ json: { resposta: respostaFixa('pedido_invalido', CONFIG) } }];
`),
    }, [660, 200]);

    const trafego = w.no('[GUARD] Tráfego (guard-trafego)', 'n8n-nodes-base.executeWorkflow', 1.2,
      L.paramsChamarComPayload('Chatbot – guard-trafego', '$json.payload'),
      [660, -100], { onError: 'continueErrorOutput' });

    const pode = w.no('[GUARD] Pode seguir?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.permitido'), [880, -100]);

    const nucleo = w.no('[AGENT] Núcleo (chat-core)', 'n8n-nodes-base.executeWorkflow', 1.2,
      L.paramsChamarComPayload('Chatbot – chat-core', PAYLOAD),
      [1100, -200], { onError: 'continueErrorOutput' });

    const fallback = w.no('[OUTPUT] Fallback', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas'], `
return [{ json: { resposta: respostaFixa('fallback', CONFIG) } }];
`),
    }, [1320, 100]);

    const responder = w.no('[OUTPUT] Responder ao widget', 'n8n-nodes-base.respondToWebhook', 1.4, {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify({ output: $json.resposta }) }}',
      options: {},
    }, [1540, 0]);

    w.liga(trigger, normalizar);
    w.liga(normalizar, valido);
    w.liga(valido, trafego, 0);
    w.liga(valido, invalido, 1);
    w.liga(trafego, pode, 0);
    w.liga(trafego, fallback, 1);
    w.liga(pode, nucleo, 0);
    w.liga(pode, responder, 1); // bloqueado: o guard-trafego já traz a resposta fixa
    w.liga(nucleo, responder, 0);
    w.liga(nucleo, fallback, 1);
    w.liga(invalido, responder);
    w.liga(fallback, responder);

    return w.json();
  },
};
