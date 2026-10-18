#!/usr/bin/env node
/**
 * Corre os casos de evals/casos/*.json contra o adaptador chat-eval e grava
 * os resultados em evals/resultados/<data>.json (fora do git).
 *
 *   node evals/correr.js                      todos os casos, 5 corridas cada
 *   node evals/correr.js faq-servicos ...     só os indicados (por id)
 *   node evals/correr.js --repeticoes 3       outro número de corridas
 *   node evals/correr.js --kb caminho.md      base usada para validar preços
 *   node evals/correr.js --reavaliar <ficheiro.json>
 *       volta a aplicar as verificações atuais às respostas gravadas numa
 *       corrida anterior, sem chamar o bot (para comparar antes/depois com
 *       as mesmas verificações)
 *
 * As respostas do modelo variam de corrida para corrida: o resultado de cada
 * caso é a taxa de acerto nas N corridas, não um ok/falha.
 *
 * Cada corrida tem uma sessão nova (UUID). Os turnos de uma corrida partilham
 * a sessão, como numa conversa real. Precisa, no .env: EVAL_WEBHOOK_URL,
 * EVAL_HEADER_NAME e EVAL_HEADER_VALUE (igual à credencial "Eval chatbot").
 *
 * Sai com código 1 se algum caso não acertar em todas as corridas. As
 * verificações não substituem ler as respostas: o ficheiro de resultados
 * tem tudo.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONFIG } = require('../src/config');
const { verificarTurno, verificarConversa, agregarCorridas } = require('./verificacoes');

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
  const r = a.indexOf('--repeticoes');
  const repeticoes = r >= 0 ? Number(a.splice(r, 2)[1]) : 5;
  if (!(repeticoes >= 1)) throw new Error('--repeticoes tem de ser um número >= 1');
  const v = a.indexOf('--reavaliar');
  const reavaliar = v >= 0 ? a.splice(v, 2)[1] : null;
  const i = a.indexOf('--kb');
  // Por omissão, a cópia local da base real (fora do git); senão, o placeholder.
  const real = path.join(RAIZ, 'kb', 'atual.local.md');
  const kb = i >= 0 ? a.splice(i, 2)[1] : fs.existsSync(real) ? real : path.join(RAIZ, 'kb', 'placeholder.md');
  return { ids: a.filter((x) => !x.startsWith('--')), kb, repeticoes, reavaliar };
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
  return { sessao, ok: todas.every((v) => v.ok), turnos, conversa };
}

function resumo(resultados) {
  for (const r of resultados) {
    const a = r.agregado;
    const pct = Math.round(a.taxa * 100);
    console.log(`${String(pct).padStart(3)}%  ${a.acertos}/${a.total}  ${r.id}  (${r.categoria})`);
    for (const f of a.falhas) console.log(`              ${f.vezes}x ${f.verificacao}`);
  }
  const acertos = resultados.reduce((s, r) => s + r.agregado.acertos, 0);
  const total = resultados.reduce((s, r) => s + r.agregado.total, 0);
  const perfeitos = resultados.filter((r) => r.agregado.acertos === r.agregado.total).length;
  console.log('');
  console.log(`Corridas certas: ${acertos}/${total} (${Math.round((acertos / total) * 100)}%). Casos a 100%: ${perfeitos}/${resultados.length}.`);
}

/** Recalcula as verificações de uma corrida gravada com os casos atuais. */
function reavaliarCorridas(ficheiro, kb) {
  const antigo = JSON.parse(fs.readFileSync(ficheiro, 'utf8'));
  const casos = carregarCasos([]);
  return antigo.resultados.map((r) => {
    const caso = casos.find((c) => c.id === r.id);
    const corridas = r.corridas.map((c) => {
      const turnos = c.turnos.map((t, i) => ({
        ...t,
        verificacoes: t.resposta ? verificarTurno(t.resposta, caso.turnos[i].esperado, kb) : t.verificacoes,
      }));
      const conversa = verificarConversa(turnos, caso, { ctasMax: CONFIG.limites.ctasMaxPorConversa });
      const ok = [...turnos.flatMap((t) => t.verificacoes), ...conversa].every((x) => x.ok);
      return { ...c, ok, turnos, conversa };
    });
    return { id: r.id, categoria: r.categoria, agregado: agregarCorridas(corridas), corridas };
  });
}

async function main() {
  const args = argumentos();
  if (args.reavaliar) {
    const kbTexto = fs.readFileSync(args.kb, 'utf8');
    console.log(`Reavaliação de ${args.reavaliar} com as verificações atuais:
`);
    resumo(reavaliarCorridas(args.reavaliar, kbTexto));
    return;
  }
  carregarEnv();
  for (const v of ['EVAL_WEBHOOK_URL', 'EVAL_HEADER_NAME', 'EVAL_HEADER_VALUE']) {
    if (!process.env[v]) throw new Error(`falta ${v} no .env`);
  }
  const { ids, kb: caminhoKb, repeticoes } = args;
  const kb = fs.readFileSync(caminhoKb, 'utf8');
  const casos = carregarCasos(ids);

  const resultados = [];
  for (const caso of casos) {
    process.stdout.write(`a correr ${caso.id} (${repeticoes}x) `);
    const corridas = [];
    for (let n = 0; n < repeticoes; n++) {
      const c = await correrCaso(caso, kb);
      process.stdout.write(c.ok ? '.' : 'x');
      corridas.push(c);
    }
    console.log('');
    resultados.push({ id: caso.id, categoria: caso.categoria, agregado: agregarCorridas(corridas), corridas });
  }

  const pasta = path.join(__dirname, 'resultados');
  fs.mkdirSync(pasta, { recursive: true });
  const ficheiro = path.join(pasta, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const modelos = [
    ...new Set(
      resultados.flatMap((r) => r.corridas.flatMap((c) => c.turnos.map((t) => t.resposta && t.resposta.modelo))).filter(Boolean)
    ),
  ];
  fs.writeFileSync(
    ficheiro,
    JSON.stringify({ quando: new Date().toISOString(), modelos, repeticoes, kb: caminhoKb, resultados }, null, 2)
  );

  console.log('');
  resumo(resultados);
  console.log(`Resultados completos: ${path.relative(RAIZ, ficheiro)}`);
  process.exitCode = resultados.every((r) => r.agregado.acertos === r.agregado.total) ? 0 : 1;
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(2);
});
