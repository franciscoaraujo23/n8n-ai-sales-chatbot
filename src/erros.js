/**
 * Normalização de erros e alerta para o Discord (canal de erros).
 *
 * Dois caminhos de entrada no error-handler:
 *  - Error Trigger: um workflow falhou (erro não tratado);
 *  - registar-erro: um workflow tratou o erro (para o visitante não o ver),
 *    mas quer que fique registado e alertado (ex.: falha a gravar o turno).
 *
 * O alerta NUNCA inclui a mensagem de erro: pode conter texto de
 * visitantes. A mensagem fica só no Postgres (tabela errors).
 *
 * JavaScript puro, sem require, copiado para os Code nodes pelo build.
 */

/** Dados do Error Trigger → registo. Cobre erros de execução e de trigger. */
function normalizarErroTrigger(d) {
  const dados = d || {};
  const wf = dados.workflow || {};
  const exec = dados.execution || {};
  const erro = exec.error || (dados.trigger && dados.trigger.error) || {};
  const no = exec.lastNodeExecuted || (erro.node && erro.node.name) || (dados.trigger ? 'trigger' : null);
  return {
    origem: 'error_trigger',
    workflow_id: wf.id ? String(wf.id) : null,
    workflow_nome: wf.name || null,
    no,
    tipo: erro.name || (dados.trigger ? 'erro_no_trigger' : 'erro'),
    mensagem: String(erro.message || erro.description || 'sem mensagem').slice(0, 4000),
    execution_id: exec.id ? String(exec.id) : null,
    execution_url: exec.url || null,
  };
}

/** Pedido do registar-erro (vindo de outro workflow) → registo. */
function normalizarErroRegistado(e) {
  const x = e || {};
  return {
    origem: 'registar_erro',
    workflow_id: x.workflow_id ? String(x.workflow_id) : null,
    workflow_nome: x.workflow_nome || null,
    no: x.no || null,
    tipo: x.tipo || 'erro_tratado',
    mensagem: String(x.mensagem || 'sem mensagem').slice(0, 4000),
    execution_id: x.execution_id ? String(x.execution_id) : null,
    // Execuções bem-sucedidas não são gravadas: um link para elas não abriria.
    execution_url: null,
  };
}

function limparLinha(valor) {
  return String(valor === null || valor === undefined ? '—' : valor)
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
}

/** Alerta para o canal de erros: onde e o quê, sem conteúdo de visitantes. */
function mensagemErro(r, erroId, janelaMinutos) {
  const linhas = [
    `**Erro no chatbot — ${limparLinha(r.workflow_nome)}**`,
    `Nó: ${limparLinha(r.no)}`,
    `Tipo: ${limparLinha(r.tipo)}`,
  ];
  if (r.execution_url) linhas.push(`Execução: <${r.execution_url}>`);
  linhas.push(`Detalhe no Postgres: \`SELECT * FROM errors WHERE id = ${Number(erroId) || 0};\``);
  linhas.push(`_Próximo alerta deste workflow só daqui a ${janelaMinutos} minutos; os erros entretanto ficam registados._`);
  return linhas.join('\n');
}

// --- o build corta a partir daqui ---
module.exports = { normalizarErroTrigger, normalizarErroRegistado, mensagemErro };
