#!/usr/bin/env node
/**
 * Gera os exports em /workflows a partir de scripts/workflows/*.js e,
 * opcionalmente, envia-os para o n8n.
 *
 *   node scripts/build.js                     só gera os JSON
 *   node scripts/build.js --enviar            gera e envia todos
 *   node scripts/build.js --enviar kb-sync    gera e envia só os indicados
 *
 * O envio cria ou atualiza cada workflow pelo nome e NUNCA o ativa.
 * Credenciais e sub-workflows são referenciados pelo nome; os IDs são
 * resolvidos no momento do envio (os exports no repositório não os têm).
 *
 * Precisa de N8N_API_URL e N8N_API_KEY (ambiente ou ficheiro .env).
 * Antes de enviar: fechar no browser os workflows abertos no editor, senão
 * uma gravação no editor reverte o envio.
 */
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ } = require('./lib');

const PASTA_DEFS = path.join(__dirname, 'workflows');
const PASTA_SAIDA = path.join(RAIZ, 'workflows');

function carregarEnv() {
  const ficheiro = path.join(RAIZ, '.env');
  if (!fs.existsSync(ficheiro)) return;
  for (const linha of fs.readFileSync(ficheiro, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function definicoes() {
  return fs
    .readdirSync(PASTA_DEFS)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => ({ slug: f.replace(/\.js$/, ''), ...require(path.join(PASTA_DEFS, f)) }));
}

function gerar(defs) {
  fs.mkdirSync(PASTA_SAIDA, { recursive: true });
  const gerados = [];
  for (const d of defs) {
    const wf = d.criar();
    fs.writeFileSync(path.join(PASTA_SAIDA, d.ficheiro), JSON.stringify(wf, null, 2) + '\n');
    gerados.push({ ...d, wf });
    console.log(`gerado   workflows/${d.ficheiro}  (${wf.nodes.length} nós)`);
  }
  return gerados;
}

// ---- API do n8n --------------------------------------------------------------

async function api(metodo, caminho, corpo) {
  const url = process.env.N8N_API_URL.replace(/\/$/, '') + '/api/v1' + caminho;
  const r = await fetch(url, {
    method: metodo,
    headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${caminho} → ${r.status}: ${texto.slice(0, 500)}`);
  return texto ? JSON.parse(texto) : null;
}

async function listar(caminho) {
  const todos = [];
  let cursor = null;
  do {
    const sep = caminho.includes('?') ? '&' : '?';
    const r = await api('GET', `${caminho}${sep}limit=250${cursor ? `&cursor=${cursor}` : ''}`);
    todos.push(...r.data);
    cursor = r.nextCursor;
  } while (cursor);
  return todos;
}

/** Troca nomes por IDs: credenciais, sub-workflows (REF:) e errorWorkflow. */
function resolver(wf, credenciais, workflows, avisos) {
  const copia = JSON.parse(JSON.stringify(wf));
  for (const no of copia.nodes) {
    for (const [tipo, ref] of Object.entries(no.credentials || {})) {
      const c = credenciais.find((x) => x.type === tipo && x.name === ref.name);
      if (c) ref.id = c.id;
      else {
        delete ref.id;
        avisos.push(`credencial em falta: "${ref.name}" (${tipo}) no nó "${no.name}"`);
      }
    }
  }
  let texto = JSON.stringify(copia);
  texto = texto.replace(/"REF:([^"]+)"/g, (m, nome) => {
    const alvo = workflows.find((w) => w.name === nome);
    if (!alvo) throw new Error(`workflow referido não existe no n8n: "${nome}" (enviar esse primeiro)`);
    return JSON.stringify(alvo.id);
  });
  const resolvido = JSON.parse(texto);
  if (resolvido.settings && resolvido.settings.errorWorkflow) {
    const nome = resolvido.settings.errorWorkflow;
    const alvo = workflows.find((w) => w.name === nome);
    if (alvo) resolvido.settings.errorWorkflow = alvo.id;
    else {
      delete resolvido.settings.errorWorkflow;
      avisos.push(`errorWorkflow "${nome}" ainda não existe; enviado sem ele`);
    }
  }
  return resolvido;
}

async function enviar(gerados) {
  carregarEnv();
  if (!process.env.N8N_API_URL || !process.env.N8N_API_KEY) {
    throw new Error('Faltam N8N_API_URL e N8N_API_KEY (ambiente ou .env).');
  }
  const credenciais = await listar('/credentials');
  let workflows = await listar('/workflows');

  for (const g of gerados) {
    const avisos = [];
    const corpo = resolver(g.wf, credenciais, workflows, avisos);
    const existente = workflows.find((w) => w.name === g.wf.name);
    let r;
    if (existente) {
      r = await api('PUT', `/workflows/${existente.id}`, corpo);
      console.log(`atualizado ${r.id}  ${r.name}  (ativo: ${r.active})`);
    } else {
      r = await api('POST', '/workflows', corpo);
      console.log(`criado    ${r.id}  ${r.name}  (inativo)`);
      workflows = await listar('/workflows');
    }
    for (const a of avisos) console.log(`   aviso: ${a}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const todos = definicoes();
  const pedidos = args.filter((a) => !a.startsWith('--'));
  const escolhidos = pedidos.length ? todos.filter((d) => pedidos.includes(d.slug)) : todos;
  if (pedidos.length && escolhidos.length !== pedidos.length) {
    throw new Error(`desconhecido: ${pedidos.filter((p) => !todos.some((d) => d.slug === p)).join(', ')}`);
  }
  const gerados = gerar(escolhidos);
  if (args.includes('--enviar')) await enviar(gerados);
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
