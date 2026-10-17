const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/erros');

test('normalizarErroTrigger: erro numa execução', () => {
  const r = e.normalizarErroTrigger({
    execution: {
      id: '231',
      url: 'https://n8n.exemplo/workflow/1/executions/231',
      error: { message: 'O visitante escreveu: ana@x.pt', name: 'NodeOperationError' },
      lastNodeExecuted: '[GUARD] Contexto do turno',
      mode: 'trigger',
    },
    workflow: { id: 'abc', name: 'Chatbot – chat-core' },
  });
  assert.deepEqual(r, {
    origem: 'error_trigger',
    workflow_id: 'abc',
    workflow_nome: 'Chatbot – chat-core',
    no: '[GUARD] Contexto do turno',
    tipo: 'NodeOperationError',
    mensagem: 'O visitante escreveu: ana@x.pt',
    execution_id: '231',
    execution_url: 'https://n8n.exemplo/workflow/1/executions/231',
  });
});

test('normalizarErroTrigger: erro no próprio trigger e dados em falta', () => {
  const r = e.normalizarErroTrigger({ trigger: { error: { message: 'cron' } }, workflow: { id: 1, name: 'kb-sync' } });
  assert.deepEqual([r.no, r.tipo, r.mensagem, r.workflow_id], ['trigger', 'erro_no_trigger', 'cron', '1']);
  const vazio = e.normalizarErroTrigger(undefined);
  assert.equal(vazio.mensagem, 'sem mensagem');
  assert.equal(vazio.workflow_id, null);
});

test('normalizarErroRegistado: sem link (execuções bem-sucedidas não ficam gravadas)', () => {
  const r = e.normalizarErroRegistado({ workflow_id: 'x', workflow_nome: 'chat-core', no: '[LOGGING] Gravar turno', tipo: 'logging_turno', mensagem: 'm'.repeat(5000), execution_id: 9 });
  assert.equal(r.origem, 'registar_erro');
  assert.equal(r.execution_url, null);
  assert.equal(r.execution_id, '9');
  assert.equal(r.mensagem.length, 4000);
});

test('mensagemErro nunca inclui a mensagem de erro', () => {
  const r = e.normalizarErroTrigger({
    execution: { id: '1', url: 'https://n8n/x', error: { message: 'texto privado do visitante', name: 'Erro' }, lastNodeExecuted: 'Nó' },
    workflow: { id: 'w', name: 'Chatbot – chat-core @everyone' },
  });
  const m = e.mensagemErro(r, 42, 5);
  assert.ok(!m.includes('texto privado'));
  assert.ok(!m.includes('@everyone'));
  assert.ok(m.includes('Execução: <https://n8n/x>'));
  assert.ok(m.includes('WHERE id = 42'));
  assert.ok(m.includes('5 minutos'));
  assert.ok(!e.mensagemErro(e.normalizarErroRegistado({}), 1, 5).includes('Execução:'));
});
