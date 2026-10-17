/**
 * Contrato da base de conhecimento.
 *
 * O kb-sync só ativa uma versão nova se tiver todos estes títulos de
 * nível 2, por esta ordem. Títulos a mais são permitidos (ficam como
 * aviso); títulos em falta, repetidos ou fora de ordem bloqueiam a
 * ativação e geram um alerta.
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 */

const TITULOS_KB = [
  'Sobre a Nautica',
  'Serviços',
  'Para quem é e para quem não é',
  'Processo',
  'Preços',
  'Chamada de diagnóstico',
  'Objeções e respostas',
  'Perguntas frequentes',
  'Credibilidade',
  'O que o bot nunca deve dizer',
  'Contactos e horário',
];

// Abaixo disto é quase de certeza um documento vazio ou uma exportação falhada.
const KB_TAMANHO_MINIMO = 500;

/**
 * Forma canónica do texto, usada para o hash: mudanças só de espaços ou
 * de quebras de linha não criam versões novas.
 */
function normalizarKb(texto) {
  return String(texto || '')
    .normalize('NFC')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Título comparável: sem negrito, sem "#" finais, minúsculas, espaços únicos. */
function chaveTitulo(titulo) {
  return String(titulo)
    .replace(/\*\*|__/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s*#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC')
    .toLowerCase();
}

/** Títulos "## …" do documento, pela ordem em que aparecem. */
function extrairTitulos(texto) {
  const titulos = [];
  const re = /^##[ \t]+(.+)$/gm;
  let m;
  while ((m = re.exec(texto)) !== null) titulos.push(m[1].trim());
  return titulos;
}

function validarKb(texto) {
  const normalizado = normalizarKb(texto);
  const encontrados = extrairTitulos(normalizado).map(chaveTitulo);
  const esperados = TITULOS_KB.map(chaveTitulo);

  const faltam = TITULOS_KB.filter((t, i) => !encontrados.includes(esperados[i]));
  const repetidos = TITULOS_KB.filter((t, i) => encontrados.filter((e) => e === esperados[i]).length > 1);
  const extra = encontrados.filter((e) => !esperados.includes(e));

  const posicoes = esperados.map((e) => encontrados.indexOf(e)).filter((p) => p >= 0);
  const foraDeOrdem = posicoes.some((p, i) => i > 0 && p < posicoes[i - 1]);
  const curto = normalizado.length < KB_TAMANHO_MINIMO;

  const erros = [];
  if (faltam.length) erros.push('faltam: ' + faltam.join(', '));
  if (repetidos.length) erros.push('repetidos: ' + repetidos.join(', '));
  if (foraDeOrdem) erros.push('títulos fora de ordem');
  if (curto) erros.push(`documento com menos de ${KB_TAMANHO_MINIMO} caracteres`);

  return {
    valido: erros.length === 0,
    erros,
    avisos: extra.length ? ['títulos extra: ' + extra.join(', ')] : [],
    texto: normalizado,
  };
}

// --- o build corta a partir daqui ---
module.exports = {
  TITULOS_KB,
  KB_TAMANHO_MINIMO,
  normalizarKb,
  chaveTitulo,
  extrairTitulos,
  validarKb,
};
