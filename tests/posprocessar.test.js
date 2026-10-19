const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG } = require('../src/config');
const p = require('../src/posprocessar');

test('linkPermitido segue a allowlist', () => {
  const sim = [
    'https://nautica-ai-agency.com/',
    'https://www.nautica-ai-agency.com/servicos',
    'https://cal.com/nautica-ai-xuismz/30min?name=Ana',
    'https://cal.com/nautica-ai-xuismz',
    'https://app.cal.com/nautica-ai-xuismz/30min',
    'mailto:hello@nautica-ai-agency.com',
  ];
  const nao = [
    'http://nautica-ai-agency.com/',
    'https://nautica-ai-agency.com.evil.com/',
    'https://evil.com/nautica-ai-agency.com',
    'https://cal.com/outra-pessoa/30min',
    'https://cal.com/nautica-ai-xuismz-falso/30min',
    'https://user:pw@nautica-ai-agency.com/',
    'https://nautica-ai-agency.com:8443/',
    'mailto:outro@exemplo.pt',
    'javascript:alert(1)',
    'não é url',
  ];
  for (const u of sim) assert.ok(p.linkPermitido(u, CONFIG), u);
  for (const u of nao) assert.ok(!p.linkPermitido(u, CONFIG), u);
});

test('filtrarLinks mantém permitidos e tira os outros', () => {
  const r = p.filtrarLinks(
    'Veja [os serviços](https://nautica-ai-agency.com/servicos) e [isto](https://evil.com/x). ' +
      'Mais em https://outro.pt/pagina, ou www.spam.com. Site: https://www.nautica-ai-agency.com/sobre.',
    CONFIG
  );
  assert.equal(
    r.texto,
    'Veja [os serviços](https://nautica-ai-agency.com/servicos) e isto. Mais em, ou. Site: https://www.nautica-ai-agency.com/sobre.'
  );
  assert.deepEqual(r.removidos, ['https://evil.com/x', 'https://outro.pt/pagina', 'www.spam.com']);
});

test('cortarResposta corta no fim de frase e não parte links', () => {
  assert.deepEqual(p.cortarResposta('curto', 100), { texto: 'curto', cortada: false });

  const frases = 'Primeira frase completa. Segunda frase completa. Terceira frase que passa do limite';
  assert.equal(p.cortarResposta(frases, 60).texto, 'Primeira frase completa. Segunda frase completa.');

  const semPontos = 'palavra '.repeat(20);
  const r = p.cortarResposta(semPontos, 50);
  assert.ok(r.texto.endsWith('palavra…'));
  assert.ok(r.texto.length <= 51);

  const comLink = 'Texto inicial sem ponto final e depois [um link](https://nautica-ai-agency.com/a-pagina-longa)';
  const c = p.cortarResposta(comLink, 60);
  assert.ok(!c.texto.includes('['), c.texto);

  const comMarcador = 'a'.repeat(40) + ' fim. Marque aqui [[MARCAR]] agora';
  assert.ok(!p.cortarResposta(comMarcador, 60).texto.includes('[['));
});

test('aplicarCta troca o marcador pelo link pré-preenchido', () => {
  const r = p.aplicarCta('Se quiser, pode [[MARCAR]].', { nome: 'Ana Silva', email: 'ana@x.pt', ctasAnteriores: 0 }, CONFIG);
  assert.equal(
    r.texto,
    'Se quiser, pode [marcar a chamada de diagnóstico](https://cal.com/nautica-ai-xuismz/30min?name=Ana%20Silva&email=ana%40x.pt).'
  );
  assert.equal(r.ctaUsada, true);

  const semDados = p.aplicarCta('Pode [[MARCAR]]', {}, CONFIG);
  assert.ok(semDados.texto.endsWith('(https://cal.com/nautica-ai-xuismz/30min)'));
});

test('aplicarCta respeita o máximo por conversa e usa só um marcador', () => {
  const esgotado = p.aplicarCta('Obrigado pela pergunta.\n\n[[MARCAR]]', { ctasAnteriores: 2 }, CONFIG);
  assert.deepEqual(esgotado, { texto: 'Obrigado pela pergunta.', ctaUsada: false });

  const dois = p.aplicarCta('A [[MARCAR]] e B [[MARCAR]].', { ctasAnteriores: 1 }, CONFIG);
  assert.equal((dois.texto.match(/cal\.com/g) || []).length, 1);
  assert.ok(!dois.texto.includes('[[MARCAR]]'));
  assert.ok(dois.texto.endsWith('e B.'));

  const linhaVazia = p.aplicarCta('Ponto um.\n- [[MARCAR]]\nFim.', { ctasAnteriores: 5 }, CONFIG);
  assert.equal(linhaVazia.texto, 'Ponto um.\n\nFim.');

  const linkDireto = p.aplicarCta('Marque em https://cal.com/nautica-ai-xuismz/30min', {}, CONFIG);
  assert.equal(linkDireto.ctaUsada, true);
});

test('detetarPtBr sinaliza marcas do português do Brasil', () => {
  assert.deepEqual(p.detetarPtBr('Estamos a trabalhar nisso e a equipa responde-lhe.'), { suspeito: false, marcadores: [] });
  assert.deepEqual(p.detetarPtBr('Vocês podem marcar uma chamada.'), { suspeito: false, marcadores: [] });
  assert.ok(p.detetarPtBr('Estamos trabalhando nisso').marcadores.includes('gerundio'));
  assert.ok(p.detetarPtBr('Você pode marcar').marcadores.includes('voce'));
  assert.ok(p.detetarPtBr('Deixe o seu contato e a nossa equipe liga').marcadores.includes('lexico'));
  assert.ok(p.detetarPtBr('Um investimento econômico').marcadores.includes('acentuacao'));
  assert.equal(p.detetarPtBr('Um investimento económico e uma experiência simples').suspeito, false);
});

test('posProcessar junta tudo pela ordem certa', () => {
  const resposta = 'Veja https://evil.com. Pode [[MARCAR]].';
  const r = p.posProcessar(resposta, { nome: 'Ana', email: null, ctasAnteriores: 0 }, CONFIG);
  assert.equal(r.texto, 'Veja. Pode [marcar a chamada de diagnóstico](https://cal.com/nautica-ai-xuismz/30min?name=Ana).');
  assert.deepEqual(r.linksRemovidos, ['https://evil.com']);
  assert.equal(r.ctaUsada, true);
  assert.equal(r.cortada, false);
  assert.equal(r.vazia, false);
  assert.equal(r.ptBr.suspeito, false);

  // O URL do Cal.com não conta para o limite de tamanho.
  const longo = 'a'.repeat(CONFIG.limites.respostaMaxChars - 20) + ' [[MARCAR]]';
  const rl = p.posProcessar(longo, {}, CONFIG);
  assert.equal(rl.cortada, false);
  assert.equal(rl.ctaUsada, true);

  assert.equal(p.posProcessar('', {}, CONFIG).vazia, true);
  assert.equal(p.posProcessar(undefined, {}, CONFIG).vazia, true);
});

test('links do Cal.com escritos pelo agente passam a marcador', () => {
  assert.equal(
    p.calParaMarcador('Marque em https://cal.com/nautica-ai-xuismz/30min. Ou [aqui](https://app.cal.com/nautica-ai-xuismz/30min).', CONFIG),
    'Marque em [[MARCAR]]. Ou [[MARCAR|aqui]].'
  );
  assert.equal(p.calParaMarcador('https://cal.com/outra-conta/30min', CONFIG), 'https://cal.com/outra-conta/30min');
});

test('URL do Cal.com da base sai pré-preenchido e respeita o máximo de CTAs', () => {
  const r = p.posProcessar('Pode marcar em https://cal.com/nautica-ai-xuismz/30min', { nome: 'Ana', email: 'a@x.pt', ctasAnteriores: 0 }, CONFIG);
  assert.ok(r.texto.includes('(https://cal.com/nautica-ai-xuismz/30min?name=Ana&email=a%40x.pt)'));
  assert.equal(r.ctaUsada, true);
  const esgotado = p.posProcessar('Marque em https://cal.com/nautica-ai-xuismz/30min.', { ctasAnteriores: 2 }, CONFIG);
  assert.ok(!esgotado.texto.includes('cal.com'));
  assert.equal(esgotado.ctaUsada, false);
});

test('URLs soltos permitidos ficam clicáveis; links Markdown ficam como estão', () => {
  assert.equal(
    p.tornarClicaveis('Veja https://nautica-ai-agency.com/marcar.html. E [isto](https://nautica-ai-agency.com/x).'),
    'Veja [nautica-ai-agency.com/marcar.html](https://nautica-ai-agency.com/marcar.html). E [isto](https://nautica-ai-agency.com/x).'
  );
  assert.equal(
    p.tornarClicaveis('www.nautica-ai-agency.com/laboratorio.html'),
    '[nautica-ai-agency.com/laboratorio.html](https://www.nautica-ai-agency.com/laboratorio.html)'
  );
});

test('grafiaMarca acentua a marca e deixa URLs e emails intactos', () => {
  assert.equal(p.grafiaMarca('A Nautica AI e a equipa da Nautica.'), 'A Náutica AI e a equipa da Náutica.');
  const intacto = 'Veja https://nautica-ai-agency.com/Nautica e escreva para hello@nautica-ai-agency.com ou Nautica-AI.';
  assert.equal(p.grafiaMarca(intacto), intacto);
  assert.equal(p.grafiaMarca('Náutica AI'), 'Náutica AI');
  assert.equal(p.posProcessar('Somos a Nautica AI.', { ctasAnteriores: 0 }, CONFIG).texto, 'Somos a Náutica AI.');
});

test('link do Cal.com com texto do agente mantém o texto (a frase continua a fazer sentido)', () => {
  const r = p.posProcessar('Se quiser, pode [marcar um horário](https://cal.com/nautica-ai-xuismz/30min) para a chamada.',
    { nome: 'Ana', email: 'a@x.pt', ctasAnteriores: 0 }, CONFIG);
  assert.equal(r.texto, 'Se quiser, pode [marcar um horário](https://cal.com/nautica-ai-xuismz/30min?name=Ana&email=a%40x.pt) para a chamada.');
  assert.equal(r.ctaUsada, true);
  // Sem texto, ou com o máximo já usado, comporta-se como o marcador simples.
  assert.ok(p.aplicarCta('Pode [[MARCAR]].', {}, CONFIG).texto.includes(`[${CONFIG.cal.textoLink}](`));
  assert.equal(p.aplicarCta('Pode [[MARCAR|marcar já]].', { ctasAnteriores: 2 }, CONFIG).texto, 'Pode.');
});

test('CTA pedida pelo visitante passa mesmo com o máximo já usado', () => {
  assert.equal(p.ctaPedida('Quero marcar uma chamada'), true);
  assert.equal(p.ctaPedida('Pode mandar o link outra vez?'), true);
  assert.equal(p.ctaPedida('queria uma reunião convosco'), true);
  assert.equal(p.ctaPedida('qualquer coisa', true), true, 'acabou de deixar o email');
  assert.equal(p.ctaPedida('Perdemos tempo a confirmar marcações por telefone'), false);
  assert.equal(p.ctaPedida('Quanto custa?'), false);
  const esgotado = { nome: 'Rui', email: 'r@x.pt', ctasAnteriores: 2 };
  assert.equal(p.aplicarCta('Pode [[MARCAR]].', esgotado, CONFIG).ctaUsada, false);
  const pedida = p.aplicarCta('Pode [[MARCAR]].', { ...esgotado, ctaPedida: true }, CONFIG);
  assert.equal(pedida.ctaUsada, true);
  assert.ok(pedida.texto.includes('name=Rui&email=r%40x.pt'));
});
