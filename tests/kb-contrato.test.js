const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kb = require('../src/kb-contrato');

const placeholder = fs.readFileSync(path.join(__dirname, '..', 'kb', 'placeholder.md'), 'utf8');

test('o placeholder cumpre o contrato, com os títulos exatos e pela ordem', () => {
  const r = kb.validarKb(placeholder);
  assert.deepEqual(r.erros, []);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.valido, true);
  assert.deepEqual(kb.extrairTitulos(placeholder), kb.TITULOS_KB);
});

test('normalizarKb ignora diferenças só de espaços e quebras de linha', () => {
  const variante = '﻿' + placeholder.replace(/\n/g, '\r\n').replace(/\n\n/g, '\n\n\n\n') + '   \n\n';
  assert.equal(kb.normalizarKb(variante), kb.normalizarKb(placeholder));
});

test('aceita títulos exportados pelo Google Docs com negrito, escapes e maiúsculas', () => {
  const exportado = placeholder
    .replace('## Serviços', '## **Serviços**')
    .replace('## Preços', '## PREÇOS ##')
    .replace('## Perguntas frequentes', '##   Perguntas   frequentes');
  assert.equal(kb.validarKb(exportado).valido, true);
});

test('falta um título → inválido', () => {
  const r = kb.validarKb(placeholder.replace('## Preços', 'Preços'));
  assert.equal(r.valido, false);
  assert.deepEqual(r.erros, ['faltam: Preços']);
});

test('títulos fora de ordem → inválido', () => {
  const trocado = placeholder.replace('## Processo', '## TEMP').replace('## Preços', '## Processo').replace('## TEMP', '## Preços');
  const r = kb.validarKb(trocado);
  assert.equal(r.valido, false);
  assert.ok(r.erros.includes('títulos fora de ordem'));
});

test('título repetido → inválido; título extra → só aviso', () => {
  assert.equal(kb.validarKb(placeholder + '\n\n## Preços\n\nOutra vez.').valido, false);
  const extra = kb.validarKb(placeholder + '\n\n## Notas internas\n\nTexto.');
  assert.equal(extra.valido, true);
  assert.deepEqual(extra.avisos, ['títulos extra: notas internas']);
});

test('documento demasiado curto → inválido', () => {
  const minimo = kb.TITULOS_KB.map((t) => `## ${t}\n`).join('\n');
  const r = kb.validarKb(minimo);
  assert.equal(r.valido, false);
  assert.ok(r.erros[0].startsWith('documento com menos de'));
});
