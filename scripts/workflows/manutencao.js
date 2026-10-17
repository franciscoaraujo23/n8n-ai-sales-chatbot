/**
 * manutencao — uma vez por dia, aplica as retenções (limpar_dados_antigos):
 * contadores de rate limit, turnos e leads com mais de 12 meses, erros com
 * mais de 3 meses e a memória do agente das sessões já apagadas.
 */
const L = require('../lib');

const NOME = 'Chatbot – manutencao';

module.exports = {
  nome: NOME,
  ordem: 10,
  ficheiro: 'manutencao.json',
  criar() {
    const w = L.workflow(NOME, L.settingsBase());

    const agenda = w.no('[TRIGGER] Todos os dias às 04:00', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 4 }] },
    }, [0, 0]);

    const limpar = w.no('[LOGGING] Limpar dados antigos', 'n8n-nodes-base.postgres', 2.6,
      L.paramsSql('SELECT limpar_dados_antigos() AS resultado'), [220, 0], { credentials: L.CRED_PG });

    w.liga(agenda, limpar);
    return w.json();
  },
};
