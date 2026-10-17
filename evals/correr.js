#!/usr/bin/env node
/**
 * Corre os casos de evals/casos/*.json contra o adaptador chat-eval e grava
 * os resultados em evals/resultados/<data>.json (fora do git).
 *
 *   node evals/correr.js                      todos os casos
 *   node evals/correr.js faq-servicos ...     só os indicados (por id)
 *   node evals/correr.js --kb caminho.md      base usada para validar preços
 *
 * Cada caso tem uma sessão nova (UUID). Os turnos de um caso partilham a
 * sessão, como numa conversa real. Precisa, no .env: EVAL_WEBHOOK_URL,
 * EVAL_HEADER_NAME e EVAL_HEADER_VALUE (igual à credencial "Eval chatbot").
 *
 * Sai com código 1 se alguma verificação falhar. As verificações não
 * substituem ler as respostas: o ficheiro de resultados tem tudo.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONFIG } = require('../src/config');
const { verificarTurno, verificarConversa } = require('./verificacoes');

const RAIZ = path.join(__dirname, '..');
const TIMEOUT_MS = 90000;

function carregarEnv() {
  const f = path.join(RAIZ, '.env');
  if (!fs.existsSync(f)) return;
  for (const linha of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function argumentos() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--kb');
  const kb = i >= 0 ? a.splice(i, 2)[1] : path.join(RAIZ, 'kb', 'placeholder.md');
  return { ids: a.filter((x) => !x.startsWith('--')), kb };
}

function carregarCasos(ids) {
  const pasta = path.join(__dirname, 'casos');
  const casos = fs
    .readdirSync(pasta)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(pasta, f), 'utf8')));
  const escolhidos = ids.length ? casos.filter((c) => ids.includes(c.id)) : casos;
  const desconhecidos = ids.filter((id) => !casos.some((c) => c.id === id));
  if (desconhecidos.length) throw new Error(`casos desconhecidos: ${desconhecidos.join(', ')}`);
  return escolhidos;
}

async function enviar(sessao, texto) {
  const inicio = Date.now();
  const r = await fetch(process.env.EVAL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [process.env.EVAL_HEADER_NAME]: process.env.EVAL_HEADER_VALUE },
    body: JSON.stringify({ session_id: sessao, texto }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const corpo = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${corpo.slice(0, 300)}`);
  return { resposta: JSON.parse(corpo), ms: Date.now() - inicio };
}

async function correrCaso(caso, kb) {
  const sessao = crypto.randomUUID();
  const turnos = [];
  for (const t of caso.turnos) {
    let resposta = null;
    let ms = null;
    let verificacoes;
    try {
      ({ resposta, ms } = await enviar(sessao, t.texto));
      verificacoes = verificarTurno(resposta, t.esperado, kb);
    } catch (e) {
      verificacoes = [{ verificacao: 'pedido ao webhook', ok: false, detalhe: e.message }];
    }
    turnos.push({ texto: t.texto, resposta, ms, verificacoes });
  }
  const conversa = verificarConversa(turnos, caso, { ctasMax: CONFIG.limites.ctasMaxPorConversa });
  const todas = [...turnos.flatMap((t) => t.verificacoes), ...conversa];
  return { id: caso.id, categoria: caso.categoria, sessao, ok: todas.every((v) => v.ok), turnos, conversa };
}

function resumo(resultados) {
  for (const r of resultados) {
    console.log(`${r.ok ? 'OK   ' : 'FALHA'}  ${r.id}  (${r.categoria})`);
    r.turnos.forEach((t, i) => {
      for (const v of t.verificacoes.filter((x) => !x.ok)) {
        console.log(`        turno ${i + 1}: ${v.verificacao}${v.detalhe ? ` — ${v.detalhe}` : ''}`);
      }
    });
    for (const v of r.conversa.filter((x) => !x.ok)) console.log(`        conversa: ${v.verificacao} — ${v.detalhe}`);
  }
  const ok = resultados.filter((r) => r.ok).length;
  console.log(`\n${ok}/${resultados.length} casos passaram.`);
}

async function main() {
  carregarEnv();
  for (const v of ['EVAL_WEBHOOK_URL', 'EVAL_HEADER_NAME', 'EVAL_HEADER_VALUE']) {
    if (!process.env[v]) throw new Error(`falta ${v} no .env`);
  }
  const { ids, kb: caminhoKb } = argumentos();
  const kb = fs.readFileSync(caminhoKb, 'utf8');
  const casos = carregarCasos(ids);

  const resultados = [];
  for (const caso of casos) {
    process.stdout.write(`a correr ${caso.id}… `);
    const r = await correrCaso(caso, kb);
    console.log(r.ok ? 'ok' : 'falhou');
    resultados.push(r);
  }

  const pasta = path.join(__dirname, 'resultados');
  fs.mkdirSync(pasta, { recursive: true });
  const ficheiro = path.join(pasta, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const modelos = [...new Set(resultados.flatMap((r) => r.turnos.map((t) => t.resposta && t.resposta.modelo)).filter(Boolean))];
  fs.writeFileSync(ficheiro, JSON.stringify({ quando: new Date().toISOString(), modelos, kb: caminhoKb, resultados }, null, 2));

  console.log('');
  resumo(resultados);
  console.log(`Resultados completos: ${path.relative(RAIZ, ficheiro)}`);
  process.exitCode = resultados.every((r) => r.ok) ? 0 : 1;
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(2);
});
