/**
 * guard-trafego — sub-workflow chamado por cada adaptador PÚBLICO (site e,
 * mais tarde, WhatsApp) antes do núcleo. Rate limit por sessão e teto
 * global por minuto e por dia.
 *
 * O adaptador de eval não o chama. Não existe nenhuma flag de "saltar
 * limites" no núcleo: seria uma porta aberta.
 *
 * O teto global é a proteção real: o session_id é gerado no cliente e
 * pode ser rodado, e o Chat Trigger não expõe o IP (ver DECISIONS.md).
 * Os pedidos bloqueados ficam registados em "turns" aqui mesmo.
 */
const L = require('../lib');

const NOME = 'Chatbot – guard-trafego';

module.exports = {
  nome: NOME,
  ordem: 10,
  ficheiro: 'guard-trafego.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const entrada = w.no('[TRIGGER] Mensagem canónica', 'n8n-nodes-base.executeWorkflowTrigger', 1.1,
      L.triggerPayload(), [0, 0]);

    const contar = w.no('[GUARD] Contar pedido', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT * FROM registar_pedido(($1::jsonb)->>0)', 'JSON.stringify([$json.session_id])'),
      [220, 0], { credentials: L.CRED_PG, ...L.RETRY_PG });

    const avaliar = w.no('[GUARD] Avaliar tráfego', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas'], `
const c = $input.first().json;
const r = avaliarTrafego(
  { sessaoMin: c.sessao_min, sessaoDia: c.sessao_dia, globalMin: c.global_min, globalDia: c.global_dia },
  CONFIG
);
return [{ json: { ...r, resposta: r.permitido ? null : respostaFixa(r.motivo, CONFIG) } }];
`),
    }, [440, 0]);

    const bloqueado = w.no('[GUARD] Bloqueado?', 'n8n-nodes-base.if', 2.2, L.paramsSe('!$json.permitido'), [660, 0]);

    // Registar o bloqueio nunca pode impedir a resposta ao visitante.
    const registar = w.no('[LOGGING] Registar bloqueio', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT * FROM registar_turno($1::jsonb)', `JSON.stringify({
  ...$('[TRIGGER] Mensagem canónica').first().json,
  resposta: $json.resposta,
  guarda: $json.motivo,
})`), [880, -100], { credentials: L.CRED_PG, onError: 'continueErrorOutput' });

    const eRegistar = L.paramsRegistarErro('[LOGGING] Registar bloqueio', 'logging_bloqueio',
      "String(($json.error && ($json.error.message || $json.error)) || 'sem detalhe')");
    const erroRegistar = w.no('[ERROR] Falha a registar bloqueio', 'n8n-nodes-base.executeWorkflow', 1.2,
      eRegistar.parametros, [1100, -200], eRegistar.extra);

    const resultado = w.no('[OUTPUT] Resultado', 'n8n-nodes-base.code', 2, {
      jsCode: `
const r = $('[GUARD] Avaliar tráfego').first().json;
return [{ json: { permitido: r.permitido, motivo: r.motivo, resposta: r.resposta } }];
`,
    }, [1320, 0]);

    w.liga(entrada, contar);
    w.liga(contar, avaliar);
    w.liga(avaliar, bloqueado);
    w.liga(bloqueado, registar, 0);
    w.liga(bloqueado, resultado, 1);
    w.liga(registar, resultado, 0);
    w.liga(registar, erroRegistar, 1);
    w.liga(erroRegistar, resultado);

    return w.json();
  },
};
