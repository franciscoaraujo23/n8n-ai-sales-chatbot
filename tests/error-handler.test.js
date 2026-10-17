// Regras do error-handler, verificadas nos workflows gerados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { wf, correr } = require('./harness');

const TODOS = fs.readdirSync(path.join(__dirname, '..', 'workflows')).filter((f) => f.endsWith('.json'));
const EH = wf('error-handler.json');

test('todos os workflows usam o error-handler, menos ele próprio', () => {
  for (const f of TODOS) {
    const w = wf(f);
    if (f === 'error-handler.json') assert.ok(!('errorWorkflow' in w.settings), 'o error-handler não se chama a si próprio');
    else assert.equal(w.settings.errorWorkflow, 'Chatbot – error-handler', f);
  }
});

test('todos guardam erros e não guardam execuções bem-sucedidas', () => {
  for (const f of TODOS) {
    const s = wf(f).settings;
    assert.deepEqual([s.saveDataSuccessExecution, s.saveDataErrorExecution], ['none', 'all'], f);
  }
});

test('ramos [ERROR] não esperam nem falham o fluxo principal', () => {
  let n = 0;
  for (const f of TODOS) {
    for (const no of wf(f).nodes.filter((x) => x.name.startsWith('[ERROR]'))) {
      n++;
      assert.equal(no.parameters.options.waitForSubWorkflow, false, `${f} / ${no.name}`);
      assert.equal(no.onError, 'continueRegularOutput', `${f} / ${no.name}`);
      assert.equal(no.parameters.workflowId.value, 'REF:Chatbot – error-handler');
      assert.ok(no.parameters.workflowInputs.value.tipo, 'tem tipo');
    }
  }
  assert.ok(n >= 6, `esperava pelo menos 6 ramos de erro, há ${n}`);
});

test('error-handler: do Error Trigger ao alerta, sem a mensagem de erro', () => {
  const [norm] = correr(EH, '[NORMALIZE] Erro do trigger', {
    entrada: [{
      execution: { id: '7', url: 'https://n8n/x/7', error: { message: 'ana@x.pt disse algo', name: 'NodeApiError' }, lastNodeExecuted: '[GUARD] Contexto do turno' },
      workflow: { id: 'w1', name: 'Chatbot – chat-core' },
    }],
  });
  assert.equal(norm.origem, 'error_trigger');
  const [m] = correr(EH, '[NORMALIZE] Mensagem de alerta', {
    entrada: [{ erro_id: 12, alertar: true }],
    nos: { '[NORMALIZE] Erro do trigger': norm },
  });
  assert.equal(m.erro_id, 12);
  assert.ok(m.mensagem.includes('Chatbot – chat-core'));
  assert.ok(!m.mensagem.includes('ana@x.pt'));
});

test('error-handler: erro registado por outro workflow', () => {
  const [norm] = correr(EH, '[NORMALIZE] Erro registado', {
    entrada: [{ workflow_id: 'w2', workflow_nome: 'Chatbot – tool-avisar-humano', no: '[OUTPUT] Discord – leads', tipo: 'aviso_nao_enviado', mensagem: 'handoff 3: 404', execution_id: '9' }],
  });
  const [m] = correr(EH, '[NORMALIZE] Mensagem de alerta', {
    entrada: [{ erro_id: 13, alertar: true }],
    nos: { '[NORMALIZE] Erro registado': norm },
  });
  assert.ok(m.mensagem.includes('Tipo: aviso_nao_enviado'));
  assert.ok(!m.mensagem.includes('Execução:'));
});
