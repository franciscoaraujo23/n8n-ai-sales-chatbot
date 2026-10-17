const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/mensagens');

test('semMencoes neutraliza @everyone, @here e menções por id', () => {
  const t = m.semMencoes('olá @everyone e @Here <@123> <@!45> <@&6> <#7> ```x```');
  assert.ok(!t.includes('@everyone') && !t.toLowerCase().includes('@here'));
  assert.ok(!/<@!?\d+>|<@&\d+>|<#\d+>/.test(t));
  assert.ok(!t.includes('```'));
  assert.equal(m.semMencoes('ana@x.pt'), 'ana@x.pt');
  assert.equal(m.semMencoes(null), '');
});

test('mensagemHandoff: completa, com CRM e sem menções', () => {
  const msg = m.mensagemHandoff({
    motivo: 'lead_qualificado',
    session_id: 'sess-1',
    nome: 'Ana',
    empresa: 'Clínica X',
    email: 'ana@x.pt',
    telefone: '+351912345678',
    problema: 'Faltas às consultas @everyone',
    resumo: 'Quer reduzir faltas.',
    crm_existente: true,
    crm_paginas: [{ crm: 'Clientes Site', url: 'https://www.notion.so/abc' }],
    notion_page_id: '898aca1a-b806-438f',
  });
  assert.ok(msg.startsWith('**Chatbot do site — Lead qualificado**'));
  assert.ok(msg.includes('Ana · Clínica X'));
  assert.ok(msg.includes('Contacto: ana@x.pt · +351912345678'));
  assert.ok(msg.includes('⚠️ Já existe no CRM dos comerciais: Clientes Site (<https://www.notion.so/abc>)'));
  assert.ok(msg.includes('Notion: <https://www.notion.so/898aca1ab806438f>'));
  assert.ok(!msg.includes('@everyone'));
});

test('mensagemHandoff: sem dados e motivo desconhecido', () => {
  const msg = m.mensagemHandoff({ motivo: 'xpto', session_id: 's' });
  assert.ok(msg.includes('— Outro**'));
  assert.ok(msg.includes('Contacto: ainda não deixou'));
  assert.ok(msg.includes('(sem resumo)'));
});

test('mensagemHandoff nunca passa os 2000 caracteres, mesmo com resumo enorme', () => {
  const msg = m.mensagemHandoff({ motivo: 'pede_humano', session_id: 's', problema: 'p'.repeat(5000), resumo: 'r'.repeat(5000) });
  assert.ok(msg.length <= m.LIMITE_DISCORD, String(msg.length));
  assert.ok(msg.includes('Sessão: s'), 'o rodapé sobrevive ao corte');
});

test('mensagemKbInvalida', () => {
  const msg = m.mensagemKbInvalida(['faltam: Preços', 'títulos fora de ordem'], 'abcdef0123456789');
  assert.ok(msg.includes('NÃO foi ativada'));
  assert.ok(msg.includes('• faltam: Preços\n• títulos fora de ordem'));
  assert.ok(msg.includes('(hash abcdef012345)'));
});
