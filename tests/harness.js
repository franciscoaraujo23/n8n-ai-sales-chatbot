// Simulação mínima do runtime dos Code nodes do n8n ($, $json, $input),
// para correr o jsCode exato dos workflows gerados em /workflows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Lê um workflow gerado (correr "node scripts/build.js" antes; o npm test fá-lo). */
function wf(ficheiro) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', ficheiro), 'utf8'));
}

/**
 * Executa um Code node. `entrada`: itens que chegam ao nó.
 * `nos`: saídas simuladas de outros nós, por nome (para $('Nome')).
 * Referências a nós que não existem no workflow falham o teste.
 */
function correr(workflow, nome, { entrada = [{}], nos = {} } = {}) {
  const no = workflow.nodes.find((n) => n.name === nome);
  assert.ok(no, `nó não existe: ${nome}`);
  const $ = (outro) => {
    assert.ok(workflow.nodes.some((n) => n.name === outro), `referência a um nó que não existe: ${outro}`);
    if (!(outro in nos)) throw new Error(`Node '${outro}' hasn't been executed`);
    const json = nos[outro];
    return { item: { json }, first: () => ({ json }), all: () => [{ json }] };
  };
  const fn = new Function('$', '$json', '$input', no.parameters.jsCode);
  if (no.parameters.mode === 'runOnceForEachItem') {
    return entrada.map((json) => fn($, json, { item: { json } }).json);
  }
  const itens = entrada.map((e) => (e && e.__binary ? { json: e.json, binary: e.__binary } : { json: e }));
  const $input = { first: () => itens[0], all: () => itens };
  return fn($, itens[0].json, $input).map((i) => i.json);
}

module.exports = { wf, correr };
