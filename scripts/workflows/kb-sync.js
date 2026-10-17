/**
 * kb-sync — de 15 em 15 minutos, lê o Google Doc da base de conhecimento
 * (exportado em Markdown, para manter os "##"), valida o contrato de
 * títulos e regista a versão. Só versões válidas ficam ativas; uma versão
 * inválida gera um alerta (uma vez por versão) e o bot continua com a
 * anterior.
 */
const L = require('../lib');

const NOME = 'Chatbot – kb-sync';

module.exports = {
  nome: NOME,
  ficheiro: 'kb-sync.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const agenda = w.no('[TRIGGER] A cada 15 minutos', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] },
    }, [0, 0]);

    const config = w.no('[NORMALIZE] Configuração', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config'], `
if (!CONFIG.kb.googleDocId) {
  throw new Error('Falta o ID do Google Doc da base de conhecimento (CONFIG.kb.googleDocId em src/config.js).');
}
return [{ json: { docId: CONFIG.kb.googleDocId } }];
`),
    }, [220, 0]);

    const exportar = w.no('[NORMALIZE] Exportar Google Doc', 'n8n-nodes-base.httpRequest', 4.2, {
      method: 'GET',
      url: '=https://www.googleapis.com/drive/v3/files/{{ $json.docId }}/export',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleDriveOAuth2Api',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'mimeType', value: 'text/markdown' }] },
      options: {
        timeout: 20000,
        response: { response: { responseFormat: 'text', outputPropertyName: 'markdown' } },
      },
    }, [440, 0], {
      credentials: L.credencial('googleDriveOAuth2Api', 'Google Drive kb'),
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 5000,
    });

    const validar = w.no('[GUARD] Validar contrato', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['kb-contrato'], `
const r = validarKb($input.first().json.markdown);
return [{
  json: {
    origem: $('[NORMALIZE] Configuração').first().json.docId,
    texto: r.texto,
    valido: r.valido,
    erros: r.erros,
    avisos: r.avisos,
  },
}];
`),
    }, [660, 0]);

    const hash = w.no('[NORMALIZE] Calcular hash', 'n8n-nodes-base.crypto', 1, {
      action: 'hash',
      type: 'SHA256',
      value: '={{ $json.texto }}',
      dataPropertyName: 'hash',
    }, [880, 0]);

    const registar = w.no('[LOGGING] Registar versão', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
SELECT k.kb_id, k.nova, k.ativada, v.hash, v.titulos_ok, v.alertado, v.erros
FROM (SELECT $1::jsonb AS p) AS x
CROSS JOIN LATERAL registar_kb(
  p->>'hash', p->>'texto', p->>'origem', (p->>'valido')::boolean,
  ARRAY(SELECT jsonb_array_elements_text(p->'erros'))
) AS k
JOIN kb_versions v ON v.id = k.kb_id
`, 'JSON.stringify({ hash: $json.hash, texto: $json.texto, origem: $json.origem, valido: $json.valido, erros: $json.erros })'),
    [1100, 0], { credentials: L.CRED_PG });

    const precisaAlerta = w.no('[GUARD] Versão inválida por alertar?', 'n8n-nodes-base.if', 2.2,
      L.paramsSe('!$json.titulos_ok && !$json.alertado'), [1320, 0]);

    const mensagem = w.no('[NORMALIZE] Mensagem de alerta', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['mensagens'], `
const v = $input.first().json;
return [{ json: { kb_id: v.kb_id, mensagem: mensagemKbInvalida(v.erros, v.hash) } }];
`),
    }, [1540, -100]);

    const d = L.paramsDiscord('$json.mensagem', 'Discord chatbot erros');
    const discord = w.no('[OUTPUT] Discord – erros', 'n8n-nodes-base.discord', 2, d.parametros, [1760, -100], d.extra);

    // Só marca como alertado se o Discord aceitou; senão tenta na próxima execução.
    const marcar = w.no('[LOGGING] Marcar alertado', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
UPDATE kb_versions SET alertado = true
FROM (SELECT $1::jsonb AS p) AS x
WHERE kb_versions.id = (p->>'kb_id')::bigint AND (p->>'ok')::boolean
RETURNING kb_versions.id
`, "JSON.stringify({ kb_id: $('[NORMALIZE] Mensagem de alerta').first().json.kb_id, ok: !$json.error })"),
    [1980, -100], { credentials: L.CRED_PG });

    w.liga(agenda, config);
    w.liga(config, exportar);
    w.liga(exportar, validar);
    w.liga(validar, hash);
    w.liga(hash, registar);
    w.liga(registar, precisaAlerta);
    w.liga(precisaAlerta, mensagem, 0);
    w.liga(mensagem, discord);
    w.liga(discord, marcar);

    return w.json();
  },
};
