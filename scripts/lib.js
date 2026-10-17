/**
 * Utilitários para definir workflows do n8n em JavaScript.
 *
 * Os Code nodes recebem o código de /src (até à linha de corte), por isso
 * o que corre no n8n é exatamente o que os testes cobrem. Os IDs dos nós
 * são determinísticos (derivados do nome), para os exports não mudarem
 * de build para build.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RAIZ = path.join(__dirname, '..');
const CORTE = '// --- o build corta a partir daqui ---';

/** Código de src/<modulo>.js até à linha de corte. */
function fonte(modulo) {
  const texto = fs.readFileSync(path.join(RAIZ, 'src', `${modulo}.js`), 'utf8');
  const i = texto.indexOf(CORTE);
  if (i < 0) throw new Error(`src/${modulo}.js não tem a linha de corte`);
  return texto.slice(0, i).trim();
}

/** prompts/<nome>.md como constante JS (PROMPT_SISTEMA para "system"). */
function prompt(nome) {
  const texto = fs.readFileSync(path.join(RAIZ, 'prompts', `${nome}.md`), 'utf8');
  return `const PROMPT_${nome === 'system' ? 'SISTEMA' : nome.toUpperCase()} = ${JSON.stringify(texto)};`;
}

/**
 * jsCode de um Code node: módulos de /src (ou "prompt:<nome>" para um
 * ficheiro de /prompts) seguidos do código do nó.
 */
function codigo(modulos, corpo) {
  return [
    `// Gerado por scripts/build.js. Não editar no n8n: editar /src e /scripts e voltar a enviar.`,
    ...modulos.map((m) =>
      m.startsWith('prompt:')
        ? `// ===== prompts/${m.slice(7)}.md =====\n${prompt(m.slice(7))}`
        : `// ===== src/${m}.js =====\n${fonte(m)}`
    ),
    `// ===== código deste nó =====\n${corpo.trim()}`,
  ].join('\n\n');
}

function uuidDe(texto) {
  const h = crypto.createHash('sha256').update(texto).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Construtor de um workflow. Os nós ficam pela ordem em que são criados;
 * `liga(a, b, saida)` junta-os.
 */
function workflow(nome, settings) {
  const nos = [];
  const ligacoes = {};

  const api = {
    no(nomeNo, tipo, versao, parametros, posicao, extra) {
      nos.push({
        id: uuidDe(`${nome}/${nomeNo}`),
        name: nomeNo,
        type: tipo,
        typeVersion: versao,
        position: posicao,
        parameters: parametros || {},
        ...(extra || {}),
      });
      return nomeNo;
    },
    liga(de, para, saida = 0, tipo = 'main') {
      ligacoes[de] = ligacoes[de] || {};
      ligacoes[de][tipo] = ligacoes[de][tipo] || [];
      while (ligacoes[de][tipo].length <= saida) ligacoes[de][tipo].push([]);
      ligacoes[de][tipo][saida].push({ node: para, type: tipo, index: 0 });
    },
    json() {
      return { name: nome, nodes: nos, connections: ligacoes, settings };
    },
  };
  return api;
}

/** Referência a uma credencial pelo nome. O ID é resolvido no envio. */
function credencial(tipo, nome) {
  return { [tipo]: { id: null, name: nome } };
}

/** Referência a outro workflow pelo nome. O ID é resolvido no envio. */
function refWorkflow(nome) {
  return { __rl: true, mode: 'id', value: `REF:${nome}`, cachedResultName: nome };
}

const ERROR_HANDLER = 'Chatbot – error-handler';

/**
 * Settings comuns: sem gravar execuções bem-sucedidas (dados pessoais) e
 * com o error-handler como errorWorkflow (o próprio error-handler passa
 * { errorWorkflow: null }). O nome é trocado pelo ID no envio.
 */
function settingsBase(extra) {
  const s = {
    executionOrder: 'v1',
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    timezone: 'Europe/Lisbon',
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: ERROR_HANDLER,
    ...(extra || {}),
  };
  for (const k of Object.keys(s)) if (s[k] === null || s[k] === undefined) delete s[k];
  return s;
}

/**
 * Ramo lateral que regista um erro TRATADO no error-handler (registo no
 * Postgres e alerta com anti-spam), sem esperar pela resposta e sem
 * nunca falhar o fluxo principal.
 */
function paramsRegistarErro(no, tipo, expressaoMensagem) {
  return {
    parametros: {
      source: 'database',
      workflowId: refWorkflow(ERROR_HANDLER),
      workflowInputs: entradas({
        workflow_id: '={{ $workflow.id }}',
        workflow_nome: '={{ $workflow.name }}',
        no,
        tipo,
        mensagem: `={{ ${expressaoMensagem} }}`,
        execution_id: '={{ $execution.id }}',
      }),
      mode: 'each',
      options: { waitForSubWorkflow: false },
    },
    extra: { onError: 'continueRegularOutput' },
  };
}

/**
 * Entradas de um sub-workflow (Execute Workflow ou tool), no formato
 * resourceMapper do n8n. `campos`: { nome: expressão }.
 */
function entradas(campos, tipos) {
  const t = tipos || {};
  return {
    mappingMode: 'defineBelow',
    value: campos,
    matchingColumns: [],
    schema: Object.keys(campos).map((id) => ({
      id,
      displayName: id,
      required: false,
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: true,
      type: t[id] || 'string',
      removed: false,
    })),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
}

/** Os cinco campos do payload canónico (schema_version 1). */
const CAMPOS_PAYLOAD = ['schema_version', 'canal', 'session_id', 'texto', 'recebido_em'];

/** Entradas do Execute Workflow Trigger para o payload canónico. */
function triggerPayload() {
  return {
    inputSource: 'workflowInputs',
    workflowInputs: {
      values: CAMPOS_PAYLOAD.map((name) => ({ name, type: name === 'schema_version' ? 'number' : 'string' })),
    },
  };
}

/** Execute Workflow que passa o payload canónico (lido de `origem`) a outro workflow. */
function paramsChamarComPayload(nomeWorkflow, origem) {
  const campos = {};
  for (const c of CAMPOS_PAYLOAD) campos[c] = `={{ ${origem}.${c} }}`;
  return {
    source: 'database',
    workflowId: refWorkflow(nomeWorkflow),
    workflowInputs: entradas(campos, { schema_version: 'number' }),
    mode: 'once',
    options: { waitForSubWorkflow: true },
  };
}

// ---- Nós usados com frequência -------------------------------------------

const CRED_PG = credencial('postgres', 'Postgres chatbot');

/** Nova tentativa curta para falhas de ligação nas queries de que tudo depende. */
const RETRY_PG = { retryOnFail: true, maxTries: 2, waitBetweenTries: 500 };

/** Postgres com um único parâmetro jsonb: vírgulas e nulls nunca partem a query. */
function paramsSql(query, expressaoParametro) {
  const p = { operation: 'executeQuery', query: query.trim(), options: {} };
  if (expressaoParametro) p.options.queryReplacement = `={{ [ ${expressaoParametro} ] }}`;
  return p;
}

/** IF com uma condição booleana. */
function paramsSe(expressao) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: uuidDe(expressao),
          leftValue: `={{ ${expressao} }}`,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  };
}

/** HTTP para a API do Notion, com a versão fixa e repetição em 429/5xx. */
function paramsNotion(metodo, url, corpo, credNome) {
  return {
    parametros: {
      method: metodo,
      url,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'notionApi',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Notion-Version', value: '2022-06-28' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: corpo,
      options: { timeout: 10000 },
    },
    extra: {
      credentials: credencial('notionApi', credNome),
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 1500,
      onError: 'continueRegularOutput',
    },
  };
}

/** Discord por webhook. Falhas não param o workflow: ficam registadas. */
function paramsDiscord(expressaoTexto, credNome) {
  return {
    parametros: { authentication: 'webhook', content: `={{ ${expressaoTexto} }}`, options: {} },
    extra: {
      credentials: credencial('discordWebhookApi', credNome),
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput',
    },
  };
}

module.exports = {
  RAIZ,
  fonte,
  codigo,
  uuidDe,
  workflow,
  credencial,
  refWorkflow,
  settingsBase,
  ERROR_HANDLER,
  paramsRegistarErro,
  prompt,
  entradas,
  CAMPOS_PAYLOAD,
  triggerPayload,
  paramsChamarComPayload,
  CRED_PG,
  RETRY_PG,
  paramsSql,
  paramsSe,
  paramsNotion,
  paramsDiscord,
};
