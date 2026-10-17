// Testa as migrations num Postgres real, em memória (PGlite: Postgres 17
// compilado para WebAssembly). Não precisa de Docker nem de ligação à VPS.
// Correr com: npm run test:sql
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const pastaSql = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');
const SESSAO = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function baseNova() {
  const db = new PGlite();
  for (const f of readdirSync(pastaSql).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(join(pastaSql, f), 'utf8'));
  }
  return db;
}

const um = async (db, sql, params) => (await db.query(sql, params)).rows[0];

test('a migration aplica num Postgres 17 limpo', async () => {
  const db = await baseNova();
  const { version } = await um(db, 'SELECT version()');
  assert.match(version, /PostgreSQL 17/);
  const { n } = await um(db, `SELECT count(*)::int AS n FROM information_schema.tables
                              WHERE table_schema = 'public'`);
  assert.equal(n, 7); // 6 do projeto + schema_migrations
});

test('registar_kb: ativa válidas, recusa inválidas, reativa versões antigas', async () => {
  const db = await baseNova();
  let r = await um(db, 'SELECT * FROM registar_kb($1, $2, $3, true)', [HASH_A, 'v1', 'doc']);
  assert.equal(r.nova, true);
  assert.equal(r.ativada, true);

  r = await um(db, 'SELECT * FROM registar_kb($1, $2, $3, true)', [HASH_A, 'v1', 'doc']);
  assert.deepEqual([r.nova, r.ativada], [false, false]);

  r = await um(db, `SELECT * FROM registar_kb($1, $2, $3, false, ARRAY['faltam: Preços'])`, [HASH_B, 'v2', 'doc']);
  assert.deepEqual([r.nova, r.ativada], [true, false]);
  assert.equal((await um(db, 'SELECT hash FROM kb_versions WHERE ativa')).hash, HASH_A);

  const HASH_C = 'c'.repeat(64);
  await db.query('SELECT * FROM registar_kb($1, $2, $3, true)', [HASH_C, 'v3', 'doc']);
  assert.equal((await um(db, 'SELECT hash FROM kb_versions WHERE ativa')).hash, HASH_C);

  // O Doc voltou ao texto da v1: reativa a v1 sem criar linha nova.
  r = await um(db, 'SELECT * FROM registar_kb($1, $2, $3, true)', [HASH_A, 'v1', 'doc']);
  assert.deepEqual([r.nova, r.ativada], [false, true]);
  assert.equal((await um(db, 'SELECT count(*)::int AS n FROM kb_versions WHERE ativa')).n, 1);

  await assert.rejects(db.query(`UPDATE kb_versions SET ativa = true WHERE hash = $1`, [HASH_B]));
  await assert.rejects(db.query('SELECT * FROM registar_kb($1, $2, $3, true)', ['nao-e-hash', 'x', 'doc']));
});

test('registar_pedido conta por sessão e globalmente, com chaves de minuto e dia', async () => {
  const db = await baseNova();
  let r;
  for (let i = 0; i < 3; i++) r = await um(db, 'SELECT * FROM registar_pedido($1)', [SESSAO]);
  assert.deepEqual(r, { sessao_min: 3, sessao_dia: 3, global_min: 3, global_dia: 3 });

  r = await um(db, 'SELECT * FROM registar_pedido($1)', ['outra-sessao']);
  assert.deepEqual(r, { sessao_min: 1, sessao_dia: 1, global_min: 4, global_dia: 4 });

  r = await um(db, 'SELECT * FROM registar_pedido($1)', ['x'.repeat(500)]);
  assert.equal(r.sessao_min, 1);
  r = await um(db, 'SELECT * FROM registar_pedido(NULL)');
  assert.equal(r.global_dia, 6);
});

test('custo_hoje e estado_sessao', async () => {
  const db = await baseNova();
  const ins = `INSERT INTO turns (session_id, canal, schema_version, texto, guarda, custo_estimado_eur, cta_usada, criado_em)
               VALUES ($1, 'site', 1, 'x', $2, $3, $4, $5)`;
  await db.query(ins, [SESSAO, null, 0.25, true, new Date()]);
  await db.query(ins, [SESSAO, 'quarentena', 0, false, new Date()]);
  await db.query(ins, [SESSAO, 'quarentena', 0, false, new Date(Date.now() - 2 * 3600e3)]);
  await db.query(ins, ['outra', null, 0.5, true, new Date(Date.now() - 3 * 86400e3)]);

  assert.equal(Number((await um(db, 'SELECT custo_hoje() AS c')).c), 0.25);
  const e = await um(db, 'SELECT * FROM estado_sessao($1, 60)', [SESSAO]);
  assert.deepEqual(e, { quarentenas_recentes: 1, ctas_anteriores: 1 });
  assert.deepEqual(await um(db, 'SELECT * FROM estado_sessao($1, 60)', ['nova']), {
    quarentenas_recentes: 0,
    ctas_anteriores: 0,
  });
});

test('leads: restrições de email e telefone, atualizado_em automático', async () => {
  const db = await baseNova();
  await db.query(`INSERT INTO leads (session_id, email, telefone) VALUES ($1, 'ana@x.pt', '+351912345678')`, [SESSAO]);
  await assert.rejects(db.query(`INSERT INTO leads (session_id, email) VALUES ('s2', 'mau')`));
  await assert.rejects(db.query(`INSERT INTO leads (session_id, telefone) VALUES ('s3', '912345678')`));
  await assert.rejects(db.query(`INSERT INTO leads (session_id) VALUES ($1)`, [SESSAO]));

  await db.query(`UPDATE leads SET atualizado_em = now() - interval '1 day'`);
  await db.query(`UPDATE leads SET nome = 'Ana' WHERE session_id = $1`, [SESSAO]);
  const { recente } = await um(db, `SELECT atualizado_em > now() - interval '1 minute' AS recente FROM leads`);
  assert.equal(recente, true);
});

test('registar_handoff é idempotente por (sessão, motivo) e conta repetições', async () => {
  const db = await baseNova();
  await db.query(`INSERT INTO leads (session_id, crm_existente) VALUES ($1, true)`, [SESSAO]);

  let r = await um(db, 'SELECT * FROM registar_handoff($1, $2, $3)', [SESSAO, 'lead_qualificado', 'resumo']);
  assert.equal(r.enviar, true);
  r = await um(db, 'SELECT * FROM registar_handoff($1, $2, $3)', [SESSAO, 'lead_qualificado', 'outro resumo']);
  assert.equal(r.enviar, false);
  r = await um(db, 'SELECT * FROM registar_handoff($1, $2, $3)', [SESSAO, 'pede_humano', 'resumo']);
  assert.equal(r.enviar, true);
  r = await um(db, 'SELECT * FROM registar_handoff($1, $2, $3)', ['sem-lead', 'outro', 'resumo']);
  assert.equal(r.enviar, true);

  const h = await um(db, `SELECT repeticoes, crm_existente, lead_id IS NOT NULL AS tem_lead
                          FROM handoffs WHERE motivo = 'lead_qualificado'`);
  assert.deepEqual(h, { repeticoes: 1, crm_existente: true, tem_lead: true });
  await assert.rejects(db.query('SELECT * FROM registar_handoff($1, $2, $3)', [SESSAO, 'motivo_livre', 'x']));
});

test('registar_erro: um alerta por workflow em cada 5 minutos', async () => {
  const db = await baseNova();
  const chamar = (wf) =>
    um(db, `SELECT * FROM registar_erro('error_trigger', $1, 'chat-core', 'nó', 'Erro', 'msg', '1', 'url')`, [wf]);

  assert.equal((await chamar('wf1')).alertar, true);
  assert.equal((await chamar('wf1')).alertar, false);
  assert.equal((await chamar('wf2')).alertar, true);

  await db.query(`UPDATE errors SET criado_em = now() - interval '6 minutes' WHERE workflow_id = 'wf1'`);
  assert.equal((await chamar('wf1')).alertar, true);
  assert.equal((await um(db, `SELECT count(*)::int AS n FROM errors`)).n, 4);
});

test('limpar_dados_antigos respeita as retenções e a memória do agente', async () => {
  const db = await baseNova();
  await db.exec(`CREATE TABLE chat_memoria (id serial PRIMARY KEY, session_id varchar(255) NOT NULL, message jsonb NOT NULL)`);
  await db.query(`INSERT INTO rate_limits VALUES ('global_dia', now() - interval '3 days', 5), ('global_dia', now(), 1)`);
  await db.query(`INSERT INTO turns (session_id, canal, schema_version, criado_em)
                  VALUES ('antiga', 'site', 1, now() - interval '13 months'), ('recente', 'site', 1, now())`);
  await db.query(`INSERT INTO chat_memoria (session_id, message) VALUES ('antiga', '{}'), ('recente', '{}')`);
  await db.query(`INSERT INTO leads (session_id) VALUES ('antiga')`);
  await db.query(`UPDATE leads SET atualizado_em = now() - interval '13 months'`);

  const { r } = await um(db, 'SELECT limpar_dados_antigos() AS r');
  assert.deepEqual(r, { rate_limits: 1, turns: 1, leads: 1, errors: 0, chat_memoria: 1 });
  assert.equal((await um(db, 'SELECT session_id FROM chat_memoria')).session_id, 'recente');
});
