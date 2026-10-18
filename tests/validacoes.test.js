const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG } = require('../src/config');
const v = require('../src/validacoes');

test('validarEmail', () => {
  assert.deepEqual(v.validarEmail('  Ana.Silva@Empresa.PT '), { valido: true, email: 'ana.silva@empresa.pt' });
  assert.deepEqual(v.validarEmail('mailto:joao@exemplo.com'), { valido: true, email: 'joao@exemplo.com' });
  assert.ok(v.validarEmail('nome+tag@sub.dominio.co.uk').valido);
  for (const mau of ['', null, 'ana', 'ana@', '@empresa.pt', 'ana@empresa', 'ana@@empresa.pt', 'a b@empresa.pt', '.ana@empresa.pt', 'ana..s@empresa.pt', 'ana@-empresa.pt', 'ana@empresa.p']) {
    assert.equal(v.validarEmail(mau).valido, false, String(mau));
  }
});

test('normalizarTelefone para E.164', () => {
  const casos = {
    '912 345 678': '+351912345678',
    '+351 912-345-678': '+351912345678',
    '00351 212 345 678': '+351212345678',
    '(+351) 96.123.45.67': '+351961234567',
    '+34 612 345 678': '+34612345678',
    '+44 20 7946 0958': '+442079460958',
  };
  for (const [entrada, e164] of Object.entries(casos)) {
    assert.deepEqual(v.normalizarTelefone(entrada), { valido: true, e164 }, entrada);
  }
  for (const mau of ['', null, '12345', '812345678', '+351 812 345 678', '+351 91234567', '91234567a', '+0 123 456 789']) {
    assert.equal(v.normalizarTelefone(mau).valido, false, String(mau));
  }
});

test('validarLead grava sempre, mas marca contacto e avisos', () => {
  const r = v.validarLead({
    nome: '  Ana   Silva ',
    empresa: 'Clínica X',
    email: 'ana@clinica',
    telefone: '912345678',
    problema: 'x'.repeat(3000),
  });
  assert.equal(r.lead.nome, 'Ana Silva');
  assert.equal(r.lead.email, null);
  assert.equal(r.lead.telefone, '+351912345678');
  assert.equal(r.lead.problema.length, 2000);
  assert.equal(r.lead.setor, null);
  assert.equal(r.contactoValido, true);
  assert.deepEqual(r.avisos, ['email_invalido']);

  const semContacto = v.validarLead({ nome: 'Rui' });
  assert.equal(semContacto.contactoValido, false);
  assert.deepEqual(semContacto.avisos, []);
  assert.equal(v.validarLead(undefined).contactoValido, false);
});

test('limparCampo trata vazios e controlo', () => {
  assert.equal(v.limparCampo('   ', 10), null);
  assert.equal(v.limparCampo(undefined, 10), null);
  assert.equal(v.limparCampo('a\u0000b', 10), 'ab');
  assert.equal(v.limparCampo('abcdefghijkl', 5), 'abcde');
});

test('validarMotivo só aceita o enum; lead_qualificado só pelo aviso automático', () => {
  assert.equal(v.validarMotivo('lead_qualificado', CONFIG, 'automatico'), 'lead_qualificado');
  assert.equal(v.validarMotivo('lead_qualificado', CONFIG, 'agente'), 'outro');
  assert.equal(v.validarMotivo('lead_qualificado', CONFIG), 'outro');
  assert.equal(v.validarMotivo(' Pede_Humano ', CONFIG), 'pede_humano');
  assert.equal(v.validarMotivo('o cliente quer falar com alguém', CONFIG), 'outro');
  assert.equal(v.validarMotivo(undefined, CONFIG), 'outro');
});
