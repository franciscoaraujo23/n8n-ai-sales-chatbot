/**
 * Configuração central do chatbot.
 *
 * É o único sítio onde se mudam limites, modelo, links e textos de
 * contacto. O scripts/build.js copia este ficheiro para os Code nodes
 * que precisam dele; nos workflows nunca se editam estes valores à mão.
 *
 * Tudo o que está aqui é público (vai para os exports em /workflows).
 * Segredos ficam nas credenciais do n8n, nunca aqui.
 */
const CONFIG = {
  schemaVersion: 1,

  // Modelo escolhido pela comparação de 2026-10-18 (ver docs/DECISIONS.md), via
  // OpenRouter. Preços em USD por 1M tokens: confirmar no OpenRouter antes de
  // cada eval, porque só servem para estimar o custo (o valor real é o do
  // OpenRouter).
  modelo: {
    id: 'anthropic/claude-haiku-5.5',
    precoEntradaUsdPorMilhao: 0.1,
    precoSaidaUsdPorMilhao: 0.5,
    // Teto da resposta do modelo, incluindo o raciocínio interno que alguns
    // modelos (o Haiku 5.5, por exemplo) fazem antes de escrever: com 700, o
    // raciocínio comia parte do teto e a resposta saía cortada ou vazia. O
    // tamanho visível é limitado por limites.respostaMaxChars.
    maxTokens: 2000,
    timeoutMs: 25000,
  },
  usdParaEur: 0.92,

  memoriaJanela: 12,

  limites: {
    mensagemMaxChars: 1000,
    respostaMaxChars: 1200,
    sessaoPorMinuto: 6,
    sessaoPorDia: 60,
    globalPorMinuto: 30,
    globalPorDia: 1500,
    custoDiarioMaxEur: 1,
    quarentenasMaxPorSessao: 3,
    quarentenaBloqueioMinutos: 60,
    ctasMaxPorConversa: 2,
  },

  // Fuso usado para "por dia" (contadores e kill switch).
  fusoHorario: 'Europe/Lisbon',

  site: {
    origens: ['https://nautica-ai-agency.com', 'https://www.nautica-ai-agency.com'],
    emailContacto: 'hello@nautica-ai-agency.com',
  },

  cal: {
    url: 'https://cal.com/nautica-ai-xuismz/30min',
    textoLink: 'marcar a chamada de diagnóstico',
  },

  // Links que podem aparecer numa resposta. Tudo o resto é removido.
  linksPermitidos: [
    { host: 'nautica-ai-agency.com', prefixo: '/' },
    { host: 'www.nautica-ai-agency.com', prefixo: '/' },
    { host: 'cal.com', prefixo: '/nautica-ai-xuismz/' },
    { host: 'app.cal.com', prefixo: '/nautica-ai-xuismz/' },
  ],

  // Marcador que o agente escreve onde quer a chamada à ação.
  // O pós-processamento troca-o pelo link do Cal.com pré-preenchido.
  marcadorCta: '[[MARCAR]]',

  motivosHandoff: ['lead_qualificado', 'pede_humano', 'reclamacao', 'outro'],
  // Reservado ao aviso automático do tool-registar-lead: se o agente o pedir,
  // fica 'outro' (senão, um aviso prematuro sem contacto bloquearia o
  // automático, que é único por conversa e motivo).
  motivoAutomatico: 'lead_qualificado',

  // Leads com email destes domínios ficam só no Postgres (estado 'teste'):
  // sem Notion nem Discord. Evals e visitantes que escrevem emails de exemplo.
  leadsTeste: {
    dominios: ['exemplo.pt', 'exemplo.com', 'example.com', 'example.org', 'example.net', 'teste.pt', 'test.com'],
  },

  // Base de conhecimento: ficheiro no Google Drive lido pelo kb-sync. Pode ser
  // um .md (descarregado tal como está) ou um Google Doc (exportado em
  // Markdown). Atualizar o .md com "Gerir versões → Carregar nova versão",
  // para o ID não mudar.
  kb: {
    driveFileId: '1hObVLQh_YVhpTN6THlxmnMuHYmII-w3T', // Base_Conhecimento_Chatbot_Nautica.md
  },

  notion: {
    versaoApi: '2022-06-28',
    // Base onde o bot escreve (dentro de "CRM Clientes").
    chatbotSite: '898aca1a-b806-438f-8072-1fcaaab208f0',
    // CRMs dos comerciais: SÓ LEITURA, para saber se o contacto já existe.
    // tipoTelefone: tipo da propriedade Telefone em cada base.
    crms: [
      { nome: 'Clientes Site', id: 'b6f1d968-06dc-48fc-ac7b-fff78e32afe1', tipoTelefone: 'phone_number' },
      { nome: 'CRM Nautica AI', id: '96af931a-07df-452c-bb9b-6160712ade3c', tipoTelefone: 'rich_text' },
    ],
  },
};

// --- o build corta a partir daqui ---
module.exports = { CONFIG };
