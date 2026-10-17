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

/** jsCode de um Code node: módulos de /src seguidos do código do nó. */
function codigo(modulos, corpo) {
  return [
    `// Gerado por scripts/build.js. Não editar no n8n: editar /src e /scripts e voltar a enviar.`,
    ...modulos.map((m) => `// ===== src/${m}.js =====\n${fonte(m)}`),
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

/** Settings comuns: sem gravar execuções bem-sucedidas (dados pessoais). */
function settingsBase(extra) {
  return {
    executionOrder: 'v1',
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    timezone: 'Europe/Lisbon',
    callerPolicy: 'workflowsFromSameOwner',
    ...(extra || {}),
  };
}

// ---- Nós usados com frequência -------------------------------------------

const CRED_PG = credencial('postgres', 'Postgres chatbot');

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
  CRED_PG,
  paramsSql,
  paramsSe,
  paramsNotion,
  paramsDiscord,
};
