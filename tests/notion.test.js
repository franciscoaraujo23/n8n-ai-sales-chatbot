const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG } = require('../src/config');
const n = require('../src/notion');

const LEAD = {
  session_id: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b',
  nome: 'Ana Silva',
  empresa: 'Clínica X',
  setor: null,
  problema: 'Marcações por telefone',
  resumo: null,
  email: 'ana@x.pt',
  telefone: '+351912345678',
};

test('textoNotion parte em blocos de 2000', () => {
  assert.deepEqual(n.textoNotion(''), []);
  assert.deepEqual(n.textoNotion(null), []);
  const b = n.textoNotion('a'.repeat(4500));
  assert.deepEqual(b.map((x) => x.text.content.length), [2000, 2000, 500]);
});

test('filtroContacto: email exato e telefone pelos últimos 9 dígitos', () => {
  assert.deepEqual(n.filtroContacto({ email: 'ana@x.pt', telefone: '+351912345678' }, 'rich_text'), {
    or: [
      { property: 'Email', email: { equals: 'ana@x.pt' } },
      { property: 'Telefone', rich_text: { contains: '912345678' } },
    ],
  });
  assert.deepEqual(n.filtroContacto({ telefone: '+351912345678' }, 'phone_number'), {
    property: 'Telefone',
    phone_number: { contains: '912345678' },
  });
  assert.equal(n.filtroContacto({}, 'rich_text'), null);
  assert.equal(n.consultaContacto({}, 'rich_text'), null);
  assert.equal(n.consultaContacto({ email: 'a@b.pt' }, 'rich_text').page_size, 5);
});

test('resumirCrms: encontrado, não encontrado e falha', () => {
  const ok = (results) => ({ object: 'list', results });
  assert.deepEqual(
    n.resumirCrms([
      { crm: 'Clientes Site', resposta: ok([{ id: 'ab-cd', url: 'https://www.notion.so/abcd' }]) },
      { crm: 'CRM Nautica AI', resposta: ok([]) },
    ]),
    { crm_existente: true, crm_paginas: [{ crm: 'Clientes Site', url: 'https://www.notion.so/abcd' }] }
  );
  assert.deepEqual(n.resumirCrms([{ crm: 'A', resposta: ok([]) }, { crm: 'B', resposta: { error: { message: '404' } } }]), {
    crm_existente: false,
    crm_paginas: [],
  });
  assert.deepEqual(n.resumirCrms([{ crm: 'A', resposta: { error: {} } }, { crm: 'B', resposta: undefined }]), {
    crm_existente: null,
    crm_paginas: null,
  });
});

test('primeiraPagina', () => {
  assert.equal(n.primeiraPagina({ results: [{ id: 'p1' }, { id: 'p2' }] }), 'p1');
  assert.equal(n.primeiraPagina({ results: [] }), null);
  assert.equal(n.primeiraPagina({ error: { message: 'x' } }), null);
});

test('propriedadesLead: só campos com valor; Origem e Estado só ao criar', () => {
  const criar = n.propriedadesLead(LEAD, { criar: true, crm: { crm_existente: true, crm_paginas: [{ crm: 'A', url: 'https://www.notion.so/x' }] } });
  assert.equal(criar.Nome.title[0].text.content, 'Ana Silva');
  assert.equal(criar.Email.email, 'ana@x.pt');
  assert.equal(criar.Telefone.phone_number, '+351912345678');
  assert.equal(criar.Origem.select.name, 'Chatbot');
  assert.equal(criar.Estado.select.name, 'Novo');
  assert.equal(criar['Já no CRM'].checkbox, true);
  assert.equal(criar['Página no CRM'].url, 'https://www.notion.so/x');
  assert.ok(!('Setor' in criar), 'campo vazio não é enviado');
  assert.ok(!('Resumo da conversa' in criar));

  const atualizar = n.propriedadesLead(LEAD, { criar: false, crm: { crm_existente: null } });
  assert.ok(!('Estado' in atualizar), 'o Estado é da equipa depois de criado');
  assert.ok(!('Origem' in atualizar));
  assert.ok(!('Já no CRM' in atualizar), 'verificação falhada não sobrescreve');

  assert.equal(n.propriedadesLead({ telefone: '+351912345678' }, {}).Nome.title[0].text.content, '+351912345678');
});

test('pedidoGravarLead: PATCH com página, POST sem página', () => {
  const p = n.pedidoGravarLead(LEAD, 'pag-1', null, CONFIG);
  assert.equal(p.metodo, 'PATCH');
  assert.equal(p.url, 'https://api.notion.com/v1/pages/pag-1');
  assert.ok(!p.corpo.parent);

  const c = n.pedidoGravarLead(LEAD, null, null, CONFIG);
  assert.equal(c.metodo, 'POST');
  assert.equal(c.corpo.parent.database_id, CONFIG.notion.chatbotSite);
  assert.equal(c.corpo.properties.Estado.select.name, 'Novo');
});

test('erroNotion', () => {
  assert.equal(n.erroNotion({ object: 'page', id: 'x' }), null);
  assert.equal(n.erroNotion({ error: { message: 'timeout' } }), 'timeout');
  assert.equal(n.erroNotion({ object: 'error', status: 400, code: 'validation_error', message: 'mau' }), '400 validation_error: mau');
  assert.equal(n.erroNotion(undefined), 'sem resposta');
});
