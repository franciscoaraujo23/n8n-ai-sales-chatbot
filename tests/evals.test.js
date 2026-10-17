const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v = require('../evals/verificacoes');

const KB = fs.readFileSync(path.join(__dirname, '..', 'kb', 'placeholder.md'), 'utf8');
const ok = (lista) => lista.every((x) => x.ok);
const falhas = (lista) => lista.filter((x) => !x.ok).map((x) => x.verificacao);

test('precosEm apanha os formatos comuns', () => {
  assert.deepEqual(v.precosEm('a partir de 500 € ou €59,99 e 1.200€, ou 99 euros'), ['500', '59,99', '1200', '99']);
  assert.deepEqual(v.precosEm('sem preços aqui, só 30 minutos'), []);
  assert.ok(v.precosEm(KB).includes('500') && v.precosEm(KB).includes('99'));
});

test('contem: texto sem maiúsculas ou /regex/', () => {
  assert.ok(v.contem('Olá Ana', 'olá'));
  assert.ok(v.contem('Diagnóstico gratuito', '/diagn[oó]stico/i'));
  assert.ok(!v.contem('nada', '/x+/'));
});

test('turno bom passa as verificações por omissão', () => {
  const r = { resposta: 'Fazemos automação de processos a partir de 500 €.', tools: [], pt_br: [], fallback: false, cta_usada: false };
  assert.ok(ok(v.verificarTurno(r, { deve_conter: ['/automa/i'], cta: false, sem_tools: true }, KB)));
});

test('apanha preço inventado, pt-BR, fallback e tool em falta', () => {
  const r = { resposta: 'Uma app custa 3000 €.', tools: ['_TOOL_avisar_humano'], pt_br: ['voce'], fallback: true, cta_usada: true };
  const f = falhas(v.verificarTurno(r, { tools_inclui: ['registar_lead'], cta: false }, KB));
  assert.deepEqual(f.sort(), ['não propôs a chamada', 'sem fallback', 'sem marcas de pt-BR', 'só preços da base', 'usou registar_lead'].sort());
});

test('turno bloqueado: verifica a guarda e não exige o resto', () => {
  const r = { resposta: 'Não posso ajudar com esse pedido.', guarda: 'quarentena', tools: [], pt_br: [] };
  assert.ok(ok(v.verificarTurno(r, { guarda: 'quarentena' }, KB)));
  assert.deepEqual(falhas(v.verificarTurno({ ...r, guarda: null }, { guarda: 'quarentena' }, KB)), ['guarda = quarentena']);
});

test('erro do núcleo é uma falha clara', () => {
  const res = v.verificarTurno({ erro_nucleo: 'timeout', resposta: null }, {}, KB);
  assert.deepEqual(res, [{ verificacao: 'núcleo respondeu', ok: false, detalhe: 'timeout' }]);
});

test('verificações da conversa: CTAs, tools e chamada proposta', () => {
  const turnos = [
    { resposta: { cta_usada: true, tools: [] } },
    { resposta: { cta_usada: true, tools: ['_TOOL_registar_lead'] } },
    { resposta: { cta_usada: true, tools: [] } },
  ];
  const caso = { conversa: { tools_inclui: ['registar_lead', 'avisar_humano'], cta_em_algum_turno: true } };
  assert.deepEqual(falhas(v.verificarConversa(turnos, caso, { ctasMax: 2 })), ['no máximo 2 chamadas à ação', 'usou avisar_humano em algum turno']);
});

test('todos os casos em evals/casos são JSON válidos e bem formados', () => {
  const pasta = path.join(__dirname, '..', 'evals', 'casos');
  const ficheiros = fs.readdirSync(pasta).filter((f) => f.endsWith('.json'));
  assert.ok(ficheiros.length >= 10, `há ${ficheiros.length} casos`);
  const ids = new Set();
  for (const f of ficheiros) {
    const c = JSON.parse(fs.readFileSync(path.join(pasta, f), 'utf8'));
    assert.ok(c.id && !ids.has(c.id), `${f}: id em falta ou repetido`);
    ids.add(c.id);
    assert.ok(c.categoria && c.descricao, `${f}: categoria e descrição`);
    assert.ok(Array.isArray(c.turnos) && c.turnos.length, `${f}: turnos`);
    for (const t of c.turnos) {
      assert.equal(typeof t.texto, 'string', `${f}: texto do turno`);
      for (const p of [...((t.esperado || {}).deve_conter || []), ...((t.esperado || {}).nao_deve_conter || [])]) {
        if (p.startsWith('/')) assert.ok(/^\/.*\/[a-z]*$/s.test(p), `${f}: regex mal escrita ${p}`);
      }
    }
  }
});
