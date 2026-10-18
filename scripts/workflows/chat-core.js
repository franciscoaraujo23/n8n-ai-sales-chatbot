/**
 * chat-core — o núcleo do chatbot. Recebe o payload canónico de qualquer
 * adaptador e devolve a resposta. Não sabe de que canal veio a mensagem:
 * o campo "canal" só é registado, nunca decide nada.
 *
 *   validar payload → contexto (1 query) → guardas de conteúdo e custo
 *     ├─ bloqueado → resposta fixa (sem LLM)
 *     └─ permitido → agente → pós-processamento
 *                      └─ erro/timeout → fallback útil
 *   → montar e gravar o turno (uma falha aqui não parte a resposta)
 *   → devolver ao adaptador
 */
const L = require('../lib');
const { CONFIG } = require('../../src/config');

const NOME = 'Chatbot – chat-core';
const NO_PREPARAR = "$('[NORMALIZE] Preparar contexto').first().json";

module.exports = {
  nome: NOME,
  ordem: 20,
  ficheiro: 'chat-core.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const entrada = w.no('[TRIGGER] Mensagem canónica', 'n8n-nodes-base.executeWorkflowTrigger', 1.1,
      L.triggerPayload(), [0, 0]);

    const validar = w.no('[NORMALIZE] Validar payload', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config'], `
// Contrato com os adaptadores: payload canónico versionado.
const p = $input.first().json;
if (Number(p.schema_version) !== CONFIG.schemaVersion) {
  throw new Error('schema_version não suportada: ' + p.schema_version);
}
return [{
  json: {
    payload: {
      schema_version: CONFIG.schemaVersion,
      canal: String(p.canal || 'desconhecido'),
      session_id: String(p.session_id || ''),
      texto: p.texto === null || p.texto === undefined ? '' : String(p.texto),
      recebido_em: p.recebido_em || new Date().toISOString(),
    },
    parametros: {
      bloqueio: CONFIG.limites.quarentenaBloqueioMinutos,
      mensagens: CONFIG.memoriaJanela,
    },
  },
}];
`),
    }, [220, 0]);

    const contexto = w.no('[GUARD] Contexto do turno', 'n8n-nodes-base.postgres', 2.6, L.paramsSql(`
SELECT c.*
FROM (SELECT $1::jsonb AS p) AS x
CROSS JOIN LATERAL contexto_turno(p->>'session_id', (p->>'bloqueio')::integer, (p->>'mensagens')::integer,
                                  'Europe/Lisbon', p->>'canal') AS c
`, 'JSON.stringify({ session_id: $json.payload.session_id, canal: $json.payload.canal, ...$json.parametros })'),
    [440, 0], { credentials: L.CRED_PG, ...L.RETRY_PG });

    const avaliar = w.no('[GUARD] Avaliar conteúdo e custo', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas'], `
const p = $('[NORMALIZE] Validar payload').first().json.payload;
const c = $input.first().json;

let r = avaliarConteudo(p, CONFIG, { quarentenasRecentes: c.quarentenas_recentes });
if (r.permitido) {
  // O custo e o teto são os do canal do turno (orçamentos separados).
  const custo = avaliarCusto(c.custo_hoje, p.canal, CONFIG);
  if (!custo.permitido) r = { ...r, ...custo };
}
// Sem base de conhecimento ativa, o agente não responde (inventaria).
if (r.permitido && !c.kb_conteudo) r = { ...r, permitido: false, motivo: 'sem_kb' };

return [{ json: { ...r, contexto: c } }];
`),
    }, [660, 0]);

    const permitido = w.no('[GUARD] Pode chamar o LLM?', 'n8n-nodes-base.if', 2.2, L.paramsSe('$json.permitido'), [880, 0]);

    // --- Bloqueado: resposta fixa, sem LLM --------------------------------
    const fixa = w.no('[OUTPUT] Resposta fixa', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas'], `
const r = $input.first().json;
return [{
  json: {
    resposta: respostaFixa(r.motivo, CONFIG),
    guarda: r.motivo,
    regras: r.regras || [],
    kb_hash: r.contexto.kb_hash,
  },
}];
`),
    }, [1100, 200]);

    // --- Agente -----------------------------------------------------------
    const preparar = w.no('[NORMALIZE] Preparar contexto', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'contexto', 'prompt:system'], `
const r = $input.first().json;
const c = r.contexto;
const sistema = montarMensagemSistema(PROMPT_SISTEMA, c.kb_conteudo, {
  ctasAnteriores: c.ctas_anteriores,
  nome: c.lead_nome,
  temContacto: Boolean(c.lead_email || c.lead_telefone),
}, CONFIG);
return [{
  json: {
    session_id: $('[NORMALIZE] Validar payload').first().json.payload.session_id,
    texto: r.texto,
    sistema,
  },
}];
`),
    }, [1100, -200]);

    const agente = w.no('[AGENT] Assistente Nautica', '@n8n/n8n-nodes-langchain.agent', 3.1, {
      promptType: 'define',
      text: '={{ $json.texto }}',
      options: {
        systemMessage: '={{ $json.sistema }}',
        maxIterations: 6,
        returnIntermediateSteps: true,
        enableStreaming: false,
      },
    }, [1320, -200], { onError: 'continueErrorOutput' });

    // O modelo vem de src/config.js (único sítio onde se escolhe).
    const modelo = w.no('[AGENT] Modelo (OpenRouter)', '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, {
      model: CONFIG.modelo.id,
      options: {
        temperature: 0.3,
        maxTokens: CONFIG.modelo.maxTokens,
        timeout: CONFIG.modelo.timeoutMs,
        maxRetries: 1,
      },
    }, [1200, 20], { credentials: L.credencial('openRouterApi', 'OpenRouter chatbot') });

    // contextWindowLength conta interações (pergunta + resposta), não
    // mensagens: 12 mensagens = 6 interações.
    const memoria = w.no('[AGENT] Memória (Postgres)', '@n8n/n8n-nodes-langchain.memoryPostgresChat', 1.4, {
      sessionIdType: 'customKey',
      sessionKey: `={{ ${NO_PREPARAR}.session_id }}`,
      tableName: 'chat_memoria',
      contextWindowLength: CONFIG.memoriaJanela / 2,
    }, [1340, 20], { credentials: L.CRED_PG });

    const sessao = `={{ ${NO_PREPARAR}.session_id }}`;
    const toolLead = w.no('[TOOL] registar_lead', '@n8n/n8n-nodes-langchain.toolWorkflow', 2.2, {
      description:
        'Guarda os dados do visitante para a equipa da Náutica. Envia tudo o que já sabes; ' +
        'campos que não sabes ficam vazios e não apagam os anteriores. Devolve uma frase curta ' +
        'a dizer se os dados ficaram guardados ou se o email/telefone parecem inválidos.',
      workflowId: L.refWorkflow('Chatbot – tool-registar-lead'),
      workflowInputs: L.entradas({
        session_id: sessao,
        nome: "={{ $fromAI('nome', 'Nome do visitante, se o disse', 'string') }}",
        empresa: "={{ $fromAI('empresa', 'Nome da empresa do visitante, se o disse', 'string') }}",
        setor: "={{ $fromAI('setor', 'Setor de atividade da empresa', 'string') }}",
        problema: "={{ $fromAI('problema', 'Problema ou processo que o visitante quer resolver, nas palavras dele', 'string') }}",
        email: "={{ $fromAI('email', 'Email do visitante, exatamente como o escreveu', 'string') }}",
        telefone: "={{ $fromAI('telefone', 'Telefone do visitante, exatamente como o escreveu', 'string') }}",
        resumo: "={{ $fromAI('resumo', 'Resumo da conversa em 2 a 4 frases, em português de Portugal', 'string') }}",
      }),
    }, [1480, 20]);

    const toolHumano = w.no('[TOOL] avisar_humano', '@n8n/n8n-nodes-langchain.toolWorkflow', 2.2, {
      description:
        'Avisa a equipa da Náutica sobre esta conversa. Usa quando o visitante pede uma pessoa ' +
        'faz uma reclamação, ou é um lead qualificado que já deixou contacto.',
      workflowId: L.refWorkflow('Chatbot – tool-avisar-humano'),
      workflowInputs: L.entradas({
        session_id: sessao,
        motivo: `={{ $fromAI('motivo', 'Exatamente um de: ${CONFIG.motivosHandoff.filter((m) => m !== CONFIG.motivoAutomatico).join(', ')}', 'string') }}`,
        origem: 'agente',
        resumo: "={{ $fromAI('resumo', 'Resumo da conversa para a equipa continuar sem a reler, em português de Portugal', 'string') }}",
      }),
    }, [1620, 20]);

    // Depois do agente: dados atuais do lead, para pré-preencher a marcação
    // (a tool registar_lead pode tê-los gravado neste mesmo turno).
    const leadAtual = w.no('[OUTPUT] Dados para a marcação', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT nome, email FROM leads WHERE session_id = ($1::jsonb)->>0',
        `JSON.stringify([${NO_PREPARAR}.session_id])`),
      [1540, -300], { credentials: L.CRED_PG, alwaysOutputData: true, onError: 'continueRegularOutput' });

    const pos = w.no('[OUTPUT] Pós-processar', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas', 'posprocessar', 'contexto'], `
const a = $('[AGENT] Assistente Nautica').first().json;
const prep = $('[NORMALIZE] Preparar contexto').first().json;
const c = $('[GUARD] Avaliar conteúdo e custo').first().json.contexto;
const lead = $input.first().json || {};

const pp = posProcessar(a.output, {
  nome: lead.nome || c.lead_nome,
  email: lead.email || c.lead_email,
  ctasAnteriores: c.ctas_anteriores,
}, CONFIG);
const { tools, passos } = resumirPassos(a.intermediateSteps);
const consumo = estimarConsumo({
  sistemaChars: prep.sistema.length,
  historicoChars: c.historico_chars,
  textoChars: prep.texto.length,
  respostaChars: String(a.output || '').length,
  passos,
}, CONFIG);

return [{
  json: {
    resposta: pp.vazia ? respostaFixa('fallback', CONFIG) : pp.texto,
    fallback: pp.vazia,
    tools,
    cta_usada: pp.ctaUsada,
    resposta_cortada: pp.cortada,
    links_removidos: pp.linksRemovidos,
    pt_br: pp.ptBr.marcadores,
    tokens_entrada_est: consumo.tokensEntrada,
    tokens_saida_est: consumo.tokensSaida,
    custo_estimado_eur: consumo.custoEur,
    kb_hash: c.kb_hash,
    modelo: CONFIG.modelo.id,
  },
}];
`),
    }, [1760, -300]);

    const fallback = w.no('[OUTPUT] Fallback', 'n8n-nodes-base.code', 2, {
      jsCode: L.codigo(['config', 'guardas'], `
// O agente falhou ou excedeu o tempo: o visitante recebe sempre uma saída útil.
const c = $('[GUARD] Avaliar conteúdo e custo').first().json.contexto;
return [{
  json: {
    resposta: respostaFixa('fallback', CONFIG),
    fallback: true,
    kb_hash: c.kb_hash,
    modelo: CONFIG.modelo.id,
  },
}];
`),
    }, [1760, -100]);

    // --- Erros tratados: ficam registados e alertados (error-handler) -------
    // Em linha e sem esperar: o Execute Workflow devolve o item que recebeu,
    // por isso o fluxo principal segue com os mesmos dados.
    const eAgente = L.paramsRegistarErro('[AGENT] Assistente Nautica', 'agente_falhou',
      "String(($json.error && ($json.error.message || $json.error)) || 'sem detalhe')");
    const erroAgente = w.no('[ERROR] Agente falhou', 'n8n-nodes-base.executeWorkflow', 1.2,
      eAgente.parametros, [1540, -100], eAgente.extra);

    const faltaKb = w.no('[GUARD] Falta a base de conhecimento?', 'n8n-nodes-base.if', 2.2,
      L.paramsSe("$json.guarda === 'sem_kb'"), [1320, 200]);
    const eKb = L.paramsRegistarErro('[GUARD] Avaliar conteúdo e custo', 'sem_kb',
      "'Não há versão ativa em kb_versions: o bot está a responder só com o fallback.'");
    const erroKb = w.no('[ERROR] Base de conhecimento em falta', 'n8n-nodes-base.executeWorkflow', 1.2,
      eKb.parametros, [1540, 150], eKb.extra);

    // --- Registo do turno e resposta ---------------------------------------
    const montar = w.no('[LOGGING] Montar turno', 'n8n-nodes-base.code', 2, {
      jsCode: `
const p = $('[NORMALIZE] Validar payload').first().json.payload;
const r = $input.first().json;
return [{
  json: {
    ...p,
    resposta: r.resposta,
    guarda: r.guarda || null,
    regras: r.regras || [],
    tools: r.tools || [],
    fallback: Boolean(r.fallback),
    cta_usada: Boolean(r.cta_usada),
    resposta_cortada: Boolean(r.resposta_cortada),
    links_removidos: r.links_removidos || [],
    pt_br: r.pt_br || [],
    tokens_entrada_est: r.tokens_entrada_est ?? null,
    tokens_saida_est: r.tokens_saida_est ?? null,
    custo_estimado_eur: r.custo_estimado_eur ?? 0,
    kb_hash: r.kb_hash || null,
    modelo: r.modelo || null,
    latencia_ms: Math.max(0, Date.now() - Date.parse(p.recebido_em)) || null,
  },
}];
`,
    }, [1980, 0]);

    // Uma falha a gravar não pode partir a resposta (error output segue em frente).
    const gravar = w.no('[LOGGING] Gravar turno', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT * FROM registar_turno($1::jsonb)', 'JSON.stringify($json)'),
      [2200, 0], { credentials: L.CRED_PG, onError: 'continueErrorOutput' });

    const eGravar = L.paramsRegistarErro('[LOGGING] Gravar turno', 'logging_turno',
      "String(($json.error && ($json.error.message || $json.error)) || 'sem detalhe')");
    const erroGravar = w.no('[ERROR] Falha a gravar turno', 'n8n-nodes-base.executeWorkflow', 1.2,
      eGravar.parametros, [2420, 150], eGravar.extra);

    const devolver = w.no('[OUTPUT] Devolver ao adaptador', 'n8n-nodes-base.code', 2, {
      jsCode: `
const t = $('[LOGGING] Montar turno').first().json;
return [{
  json: {
    resposta: t.resposta,
    guarda: t.guarda,
    regras: t.regras,
    fallback: t.fallback,
    tools: t.tools,
    cta_usada: t.cta_usada,
    links_removidos: t.links_removidos,
    pt_br: t.pt_br,
    kb_hash: t.kb_hash,
    modelo: t.modelo,
    turno_registado: Boolean($input.first().json.turno_id),
  },
}];
`,
    }, [2640, 0]);

    w.liga(entrada, validar);
    w.liga(validar, contexto);
    w.liga(contexto, avaliar);
    w.liga(avaliar, permitido);
    w.liga(permitido, preparar, 0);
    w.liga(permitido, fixa, 1);
    w.liga(preparar, agente);
    w.liga(modelo, agente, 0, 'ai_languageModel');
    w.liga(memoria, agente, 0, 'ai_memory');
    w.liga(toolLead, agente, 0, 'ai_tool');
    w.liga(toolHumano, agente, 0, 'ai_tool');
    w.liga(agente, leadAtual, 0);
    w.liga(agente, erroAgente, 1);
    w.liga(erroAgente, fallback);
    w.liga(leadAtual, pos);
    w.liga(pos, montar);
    w.liga(fallback, montar);
    w.liga(fixa, faltaKb);
    w.liga(faltaKb, erroKb, 0);
    w.liga(faltaKb, montar, 1);
    w.liga(erroKb, montar);
    w.liga(montar, gravar);
    w.liga(gravar, devolver, 0);
    w.liga(gravar, erroGravar, 1);
    w.liga(erroGravar, devolver);

    return w.json();
  },
};
