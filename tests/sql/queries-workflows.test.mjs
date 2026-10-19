// Corre em PGlite as queries EXATAS dos nós Postgres dos workflows gerados
// (correr "node scripts/build.js" antes; o npm test fá-lo). As funções SQL
// podiam estar certas e a query à volta delas não — foi o que aconteceu com
// o registo de versões do kb-sync (a linha inserida não é visível na mesma
// instrução).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SESSAO = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

async function baseNova() {
  const db = new PGlite();
  const pasta = join(raiz, 'sql');
  for (const f of readdirSync(pasta).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(join(pasta, f), 'utf8'));
  }
  return db;
}

function query(ficheiro, no) {
  const wf = JSON.parse(readFileSync(join(raiz, 'workflows', ficheiro), 'utf8'));
  const n = wf.nodes.find((x) => x.name === no);
  assert.ok(n, `nó não existe: ${no}`);
  return n.parameters.query;
}

const correr = async (db, sql, p) => (await db.query(sql, [JSON.stringify(p)])).rows;

test('kb-sync: registar versão devolve sempre uma linha, nova ou repetida', async () => {
  const db = await baseNova();
  const sql = query('kb-sync.json', '[LOGGING] Registar versão');
  const valida = { hash: 'a'.repeat(64), texto: 'v1', origem: 'doc', valido: true, erros: [] };
  const invalida = { hash: 'b'.repeat(64), texto: 'v2', origem: 'doc', valido: false, erros: ['faltam: Preços'] };

  let [r] = await correr(db, sql, valida);
  assert.deepEqual([r.nova, r.ativada, r.titulos_ok, r.alertado], [true, true, true, false]);

  [r] = await correr(db, sql, invalida);
  assert.deepEqual([r.nova, r.ativada, r.titulos_ok, r.alertado, r.erros], [true, false, false, false, ['faltam: Preços']]);
  assert.equal(r.hash, 'b'.repeat(64));

  // Depois do alerta, a mesma versão inválida não volta a alertar.
  await db.query(`UPDATE kb_versions SET alertado = true WHERE hash = $1`, ['b'.repeat(64)]);
  const rows = await correr(db, sql, invalida);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].nova, rows[0].alertado], [false, true]);
});

test('kb-sync: marcar alertado só com o Discord a aceitar', async () => {
  const db = await baseNova();
  await correr(db, query('kb-sync.json', '[LOGGING] Registar versão'), { hash: 'c'.repeat(64), texto: 'x', origem: 'doc', valido: false, erros: [] });
  const { id } = (await db.query('SELECT id FROM kb_versions')).rows[0];
  const sql = query('kb-sync.json', '[LOGGING] Marcar alertado');
  assert.equal((await correr(db, sql, { kb_id: id, ok: false })).length, 0);
  assert.equal((await correr(db, sql, { kb_id: id, ok: true })).length, 1);
});

test('tool-avisar-humano: registar aviso é idempotente por conversa e motivo', async () => {
  const db = await baseNova();
  const sql = query('tool-avisar-humano.json', '[TOOL] Registar aviso');
  const p = { session_id: SESSAO, motivo: 'lead_qualificado', resumo: 'r' };
  let [r] = await correr(db, sql, p);
  assert.deepEqual([r.enviar, r.teste], [true, false]);
  [r] = await correr(db, sql, p);
  assert.equal(r.enviar, false);

  const estado = query('tool-avisar-humano.json', '[LOGGING] Estado do envio');
  const [e] = await correr(db, estado, { handoff_id: r.handoff_id, ok: false, erro: '404' });
  assert.equal(e.discord_estado, 'falhado');
});

test('tool-avisar-humano: a fase de envio relê o lead gravado depois do aviso', async () => {
  const db = await baseNova();
  const registar = query('tool-avisar-humano.json', '[TOOL] Registar aviso');
  const reler = query('tool-avisar-humano.json', '[TOOL] Reler aviso e lead');
  const lead = (s, email) => db.query(`SELECT * FROM registar_lead($1::jsonb)`, [JSON.stringify({ session_id: s, nome: 'Rui', email, dominios_teste: ['exemplo.pt'] })]);

  // Ordem real do n8n: o aviso é gravado ANTES do lead.
  const [real] = await correr(db, registar, { session_id: SESSAO, motivo: 'pede_humano', resumo: 'r' });
  await lead(SESSAO, 'rui@empresa.pt');
  const [r] = await correr(db, reler, { handoff_id: real.handoff_id });
  assert.deepEqual([r.teste, r.email, r.nome, r.motivo, r.resumo], [false, 'rui@empresa.pt', 'Rui', 'pede_humano', 'r']);

  const [teste] = await correr(db, registar, { session_id: 'sessao-teste', motivo: 'pede_humano', resumo: 'r' });
  await lead('sessao-teste', 'rui@exemplo.pt');
  const [t2] = await correr(db, reler, { handoff_id: teste.handoff_id });
  assert.equal(t2.teste, true);
  const { rows } = await db.query('SELECT discord_estado, lead_id IS NOT NULL AS ligado FROM handoffs WHERE id = $1', [teste.handoff_id]);
  assert.deepEqual(rows[0], { discord_estado: 'teste', ligado: true });

  // Só avisos pendentes: depois de enviado, reler não devolve nada.
  await correr(db, query('tool-avisar-humano.json', '[LOGGING] Estado do envio'), { handoff_id: real.handoff_id, ok: true, erro: null });
  assert.equal((await correr(db, reler, { handoff_id: real.handoff_id })).length, 0);
});

test('tool-registar-lead: gravar, reservar e concluir pela ordem do workflow', async () => {
  const db = await baseNova();
  const [lead] = await correr(db, query('tool-registar-lead.json', '[TOOL] Gravar lead (Postgres)'), { session_id: SESSAO, nome: 'Ana', email: 'ana@x.pt' });
  assert.equal(lead.sync_estado, 'pendente');
  const reservados = await correr(db, query('tool-registar-lead.json', '[TOOL] Reservar este lead'), [SESSAO]);
  assert.equal(reservados.length, 1);
  assert.equal((await db.query(query('tool-registar-lead.json', '[TOOL] Reservar pendentes'))).rows.length, 0);
  const [fim] = await correr(db, query('tool-registar-lead.json', '[LOGGING] Concluir sync'), {
    id: lead.id, ok: true, notion_page_id: 'p1', crm_existente: false, crm_paginas: [], erro: null,
  });
  assert.equal(fim.sync_estado, 'sincronizado');
});

test('chat-core e guard-trafego: contexto, contagem e registo do turno', async () => {
  const db = await baseNova();
  const [c] = await correr(db, query('chat-core.json', '[GUARD] Contexto do turno'), { session_id: SESSAO, bloqueio: 60, mensagens: 12 });
  assert.equal(c.kb_conteudo, null);
  const [n] = await correr(db, query('guard-trafego.json', '[GUARD] Contar pedido'), [SESSAO]);
  assert.equal(n.global_dia, 1);
  const turno = { schema_version: 1, canal: 'site', session_id: SESSAO, texto: 'olá', recebido_em: new Date().toISOString(), resposta: 'x', guarda: 'limite_sessao' };
  assert.ok((await correr(db, query('guard-trafego.json', '[LOGGING] Registar bloqueio'), turno))[0].turno_id);
  assert.ok((await correr(db, query('chat-core.json', '[LOGGING] Gravar turno'), turno))[0].turno_id);
  const [lead] = await correr(db, query('chat-core.json', '[OUTPUT] Dados para a marcação'), [SESSAO]).then((r) => (r.length ? r : [null]));
  assert.equal(lead, null);
});

test('error-handler: registar erro e desmarcar alerta', async () => {
  const db = await baseNova();
  const [r] = await correr(db, query('error-handler.json', '[LOGGING] Registar erro'), {
    origem: 'error_trigger', workflow_id: 'w', workflow_nome: 'n', no: 'x', tipo: 'Erro', mensagem: 'm', execution_id: '1', execution_url: null,
  });
  assert.equal(r.alertar, true);
  assert.equal((await correr(db, query('error-handler.json', '[LOGGING] Alerta não enviado'), [r.erro_id])).length, 1);
});

test('manutencao: limpeza corre', async () => {
  const db = await baseNova();
  const [r] = (await db.query(query('manutencao.json', '[LOGGING] Limpar dados antigos'))).rows;
  assert.ok(r.resultado && 'turns' in r.resultado);
});
