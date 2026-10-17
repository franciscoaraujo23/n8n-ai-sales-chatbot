const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG } = require('../src/config');
const c = require('../src/contexto');

const PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system.md'), 'utf8');

test('mensagem de sistema: prefixo estável, estado no fim', () => {
  const a = c.montarMensagemSistema(PROMPT, '## Sobre a Nautica\nTexto', { ctasAnteriores: 0 }, CONFIG);
  const b = c.montarMensagemSistema(PROMPT, '## Sobre a Nautica\nTexto', { ctasAnteriores: 2, nome: 'Ana', temContacto: true }, CONFIG);
  const prefixo = a.slice(0, a.indexOf('# Estado desta conversa'));
  assert.ok(b.startsWith(prefixo), 'só o estado muda entre turnos');
  assert.ok(a.indexOf('# Base de conhecimento') > a.indexOf('# Papel'));
  assert.ok(b.includes('Chamadas à ação já usadas nesta conversa: 2 de 2.'));
  assert.ok(b.includes('Nome do visitante já registado: sim (Ana).'));
  assert.ok(a.includes('Email ou telefone já registado: não.'));
});

test('o prompt cumpre as decisões fechadas', () => {
  assert.ok(PROMPT.includes('[[MARCAR]]'));
  assert.ok(PROMPT.includes('português de Portugal'));
  for (const motivo of CONFIG.motivosHandoff) assert.ok(PROMPT.includes('`' + motivo + '`'), motivo);
  assert.ok(PROMPT.includes('registar_lead') && PROMPT.includes('avisar_humano'));
  assert.ok(!/cal\.com/i.test(PROMPT), 'o URL do Cal.com nunca aparece no prompt');
});

test('resumirPassos: nomes das tools sem argumentos, tamanhos para o custo', () => {
  const r = c.resumirPassos([
    { action: { tool: 'registar_lead', toolInput: { email: 'ana@x.pt' } }, observation: 'Dados guardados.' },
    { action: { tool: 'avisar_humano', toolInput: 'texto' }, observation: { resposta: 'ok' } },
    null,
  ]);
  assert.deepEqual(r.tools, ['registar_lead', 'avisar_humano', 'desconhecida']);
  assert.equal(r.passos[0].entrada, '{"email":"ana@x.pt"}');
  assert.equal(r.passos[1].saida, '{"resposta":"ok"}');
  assert.deepEqual(c.resumirPassos(undefined), { tools: [], passos: [] });
});
