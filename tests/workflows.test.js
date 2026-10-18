// Corre o jsCode exato dos Code nodes gerados em /workflows, com uma
// simulação mínima de $, $json e $input. Apanha erros de ligação entre
// nós (nomes trocados, campos que não existem) antes de chegar ao n8n.
// Correr "node scripts/build.js" antes (o npm test fá-lo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG } = require('../src/config');

const { wf, correr } = require('./harness');
const SESSAO = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

// ---- tool-registar-lead -----------------------------------------------------

const RL = wf('tool-registar-lead.json');
const LEAD_PG = {
  id: 7, session_id: SESSAO, nome: 'Ana', empresa: 'Clínica X', setor: null, problema: 'Faltas',
  resumo: 'Quer reduzir faltas', email: 'ana@x.pt', telefone: '+351912345678', notion_page_id: null,
};

test('registar-lead: validação', () => {
  const [ok] = correr(RL, '[GUARD] Validar lead', { entrada: [{ session_id: SESSAO, nome: ' Ana ', email: 'mau@', telefone: '912345678' }] });
  assert.equal(ok.valido, true);
  assert.equal(ok.lead.nome, 'Ana');
  assert.equal(ok.lead.telefone, '+351912345678');
  assert.deepEqual(ok.avisos, ['email_invalido']);

  const [mau] = correr(RL, '[GUARD] Validar lead', { entrada: [{ session_id: 'x' }] });
  assert.equal(mau.valido, false);
});

test('registar-lead: procura nos CRMs com o tipo de telefone de cada base', () => {
  const [p] = correr(RL, '[NORMALIZE] Preparar procura', { entrada: [LEAD_PG] });
  assert.equal(p.consultas.length, 2);
  assert.equal(p.consultas[0].crm, 'Clientes Site');
  assert.equal(p.consultas[0].corpo.filter.or[1].phone_number.contains, '912345678');
  assert.equal(p.consultas[1].corpo.filter.or[1].rich_text.contains, '912345678');
  assert.ok(p.urlChatbot.endsWith(`/databases/${CONFIG.notion.chatbotSite}/query`));
});

function montar(lead, procuraChatbot, crm0, crm1) {
  const [prep] = correr(RL, '[NORMALIZE] Preparar procura', { entrada: [lead] });
  return correr(RL, '[NORMALIZE] Montar página', {
    entrada: [{}],
    nos: {
      '[NORMALIZE] Preparar procura': prep,
      '[TOOL] Procurar em Clientes Site (só leitura)': crm0,
      '[TOOL] Procurar em CRM Nautica AI (só leitura)': crm1,
      '[TOOL] Procurar no Chatbot site': procuraChatbot,
    },
  })[0];
}

test('registar-lead: cria página nova quando não há nenhuma', () => {
  const m = montar(LEAD_PG, { results: [] }, { results: [] }, { results: [] });
  assert.equal(m.pedido.metodo, 'POST');
  assert.equal(m.pedido.corpo.parent.database_id, CONFIG.notion.chatbotSite);
  assert.equal(m.crm.crm_existente, false);
  assert.equal(m.lead_id, 7);
});

test('registar-lead: atualiza a página encontrada por email/telefone e marca o CRM', () => {
  const m = montar(
    LEAD_PG,
    { results: [{ id: 'pag-encontrada' }] },
    { results: [{ id: 'c1', url: 'https://www.notion.so/c1' }] },
    { error: { message: 'timeout' } }
  );
  assert.equal(m.pedido.metodo, 'PATCH');
  assert.ok(m.pedido.url.endsWith('/pages/pag-encontrada'));
  assert.equal(m.crm.crm_existente, true);
  assert.equal(m.pedido.corpo.properties['Já no CRM'].checkbox, true);
  assert.ok(!m.pedido.corpo.properties.Estado, 'não mexe no Estado de uma página existente');
});

test('registar-lead: com notion_page_id no Postgres, ignora a procura', () => {
  const m = montar({ ...LEAD_PG, notion_page_id: 'pag-guardada' }, { results: [{ id: 'outra' }] }, { results: [] }, { results: [] });
  assert.ok(m.pedido.url.endsWith('/pages/pag-guardada'));
});

test('registar-lead: resultado da sincronização', () => {
  const montado = { lead_id: 7, crm: { crm_existente: true, crm_paginas: [] } };
  const [ok] = correr(RL, '[NORMALIZE] Resultado da sync', {
    entrada: [{ object: 'page', id: 'pag-1' }],
    nos: { '[NORMALIZE] Montar página': montado },
  });
  assert.deepEqual(ok, { id: 7, ok: true, notion_page_id: 'pag-1', crm_existente: true, crm_paginas: [], erro: null });

  const [falha] = correr(RL, '[NORMALIZE] Resultado da sync', {
    entrada: [{ error: { message: 'Notion 502' } }],
    nos: { '[NORMALIZE] Montar página': montado },
  });
  assert.deepEqual([falha.ok, falha.notion_page_id, falha.erro], [false, null, 'Notion 502']);
});

test('registar-lead: resposta ao agente nunca fala de erros do Notion', () => {
  const validado = { valido: true, avisos: ['email_invalido'], contactoValido: true };
  const [r] = correr(RL, '[OUTPUT] Resposta ao agente', {
    nos: { '[GUARD] Validar lead': validado, '[TOOL] Gravar lead (Postgres)': { sync_estado: 'pendente' } },
  });
  assert.equal(r.resposta, 'Dados do visitante guardados. O email indicado não parece válido: confirme-o com o visitante.');

  const [sem] = correr(RL, '[OUTPUT] Resposta ao agente', {
    nos: { '[GUARD] Validar lead': { valido: true, avisos: [] }, '[TOOL] Gravar lead (Postgres)': { sync_estado: 'sem_contacto' } },
  });
  assert.ok(sem.resposta.includes('Ainda não há email nem telefone válidos'));

  const [agendado] = correr(RL, '[OUTPUT] Resposta ao agente');
  assert.equal(agendado.resposta, 'ok', 'nas novas tentativas agendadas não há validação');
});

// ---- tool-avisar-humano -----------------------------------------------------

const AH = wf('tool-avisar-humano.json');

test('avisar-humano: motivo fora do enum passa a "outro"', () => {
  const [v] = correr(AH, '[GUARD] Validar pedido', { entrada: [{ session_id: SESSAO, motivo: 'quer falar já', resumo: '  ' }] });
  assert.deepEqual(v, { valido: true, session_id: SESSAO, motivo: 'outro', resumo: '(sem resumo)' });
});

test('avisar-humano: mensagem junta o pedido e os dados do lead', () => {
  const [m] = correr(AH, '[NORMALIZE] Mensagem para o Discord', {
    entrada: [{ handoff_id: 3, enviar: true, nome: 'Ana', email: 'ana@x.pt', crm_existente: false, crm_paginas: [] }],
    nos: { '[GUARD] Validar pedido': { valido: true, session_id: SESSAO, motivo: 'pede_humano', resumo: 'Quer falar com alguém.' } },
  });
  assert.equal(m.handoff_id, 3);
  assert.ok(m.mensagem.includes('Pede para falar com uma pessoa'));
  assert.ok(m.mensagem.includes('Quer falar com alguém.'));
});

test('avisar-humano: resposta ao agente distingue aviso novo de repetido', () => {
  const pedido = { '[GUARD] Validar pedido': { valido: true } };
  const [novo] = correr(AH, '[OUTPUT] Resposta ao agente', { nos: { ...pedido, '[TOOL] Registar aviso': { enviar: true } } });
  const [rep] = correr(AH, '[OUTPUT] Resposta ao agente', { nos: { ...pedido, '[TOOL] Registar aviso': { enviar: false } } });
  assert.ok(novo.resposta.includes('foi avisada'));
  assert.ok(rep.resposta.includes('já tinha sido avisada'));
});

// ---- kb-sync -----------------------------------------------------------------

const KB = wf('kb-sync.json');

test('kb-sync: lê o ID do ficheiro da configuração', () => {
  const [c] = correr(KB, '[NORMALIZE] Configuração');
  assert.equal(c.docId, CONFIG.kb.driveFileId);
  const url = KB.nodes.find((n) => n.name === '[NORMALIZE] Descarregar base').parameters.url;
  assert.ok(url.includes("'/export?mimeType=text%2Fmarkdown'") && url.includes("'?alt=media&supportsAllDrives=true'"));
});

test('kb-sync: o placeholder passa o contrato no nó real', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'kb', 'placeholder.md'), 'utf8');
  const [v] = correr(KB, '[GUARD] Validar contrato', {
    entrada: [{ markdown: md }],
    nos: { '[NORMALIZE] Configuração': { docId: 'doc-1' } },
  });
  assert.deepEqual([v.valido, v.origem, v.erros], [true, 'doc-1', []]);
});

test('kb-sync: alerta de versão inválida', () => {
  const [m] = correr(KB, '[NORMALIZE] Mensagem de alerta', {
    entrada: [{ kb_id: 4, erros: ['faltam: Preços'], hash: 'f'.repeat(64) }],
  });
  assert.equal(m.kb_id, 4);
  assert.ok(m.mensagem.includes('• faltam: Preços'));
});
