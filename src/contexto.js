/**
 * Contexto do agente e leitura do que ele fez.
 *
 * A mensagem de sistema é: prompt (do repositório) + base de conhecimento
 * (versão ativa) + estado da conversa. As duas primeiras partes não mudam
 * entre turnos, por isso ficam no início: é esse prefixo estável que a
 * cache de prompt dos fornecedores aproveita. O estado, que muda, vai no fim.
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 */

function montarMensagemSistema(prompt, kbConteudo, estado, cfg) {
  const e = estado || {};
  const linhas = [
    `- Chamadas à ação já usadas nesta conversa: ${e.ctasAnteriores || 0} de ${cfg.limites.ctasMaxPorConversa}.`,
    `- Nome do visitante já registado: ${e.nome ? 'sim (' + e.nome + ')' : 'não'}.`,
    `- Email ou telefone já registado: ${e.temContacto ? 'sim' : 'não'}.`,
  ];
  return [
    String(prompt).trim(),
    '# Base de conhecimento\n\n' + String(kbConteudo).trim(),
    '# Estado desta conversa\n\n' + linhas.join('\n'),
  ].join('\n\n---\n\n');
}

function textoDe(valor) {
  if (valor === null || valor === undefined) return '';
  return typeof valor === 'string' ? valor : JSON.stringify(valor);
}

/**
 * Resume os intermediateSteps do AI Agent: nomes das tools (para o log,
 * sem os argumentos, que têm dados pessoais) e tamanhos (para o custo).
 */
function resumirPassos(passos) {
  const lista = Array.isArray(passos) ? passos : [];
  return {
    tools: lista.map((p) => (p && p.action && p.action.tool) || 'desconhecida'),
    passos: lista.map((p) => ({
      entrada: textoDe(p && p.action && p.action.toolInput),
      saida: textoDe(p && p.observation),
    })),
  };
}

// --- o build corta a partir daqui ---
module.exports = { montarMensagemSistema, resumirPassos };
