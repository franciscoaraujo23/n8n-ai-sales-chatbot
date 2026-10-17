-- 001_init.sql — schema inicial do chatbot do site.
--
-- Aplicada pelo sql/aplicar.sh, como utilizador "chatbot", na base "chatbot".
-- O aplicar.sh envolve cada migration numa transação e regista-a em
-- schema_migrations; este ficheiro não abre nem fecha transações.
--
-- Fora desta migration, de propósito:
--   chat_memoria — criada pelo nó Postgres Chat Memory do n8n no primeiro
--   uso. O nó espera um schema concreto, e replicá-lo à mão arrisca falhas
--   difíceis de ver. O schema real fica documentado no RUNBOOK.

CREATE TABLE IF NOT EXISTS schema_migrations (
  versao      text PRIMARY KEY,
  aplicada_em timestamptz NOT NULL DEFAULT now()
);

-- Atualiza atualizado_em em cada UPDATE, exceto se o próprio UPDATE o
-- definir (correções de dados e testes).
CREATE OR REPLACE FUNCTION marcar_atualizado_em() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.atualizado_em IS NOT DISTINCT FROM OLD.atualizado_em THEN
    NEW.atualizado_em := now();
  END IF;
  RETURN NEW;
END;
$$;

-- Início do dia de hoje no fuso indicado (para contadores e custo diário).
CREATE OR REPLACE FUNCTION inicio_do_dia(p_fuso text DEFAULT 'Europe/Lisbon') RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT date_trunc('day', now() AT TIME ZONE p_fuso) AT TIME ZONE p_fuso;
$$;


-- ---------------------------------------------------------------------------
-- kb_versions: cada versão distinta da base de conhecimento.
-- No máximo uma ativa; só versões que cumprem o contrato podem estar ativas.
-- ---------------------------------------------------------------------------
CREATE TABLE kb_versions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hash        text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  conteudo    text NOT NULL,
  origem      text NOT NULL,                 -- id do Google Doc, ou 'placeholder'
  titulos_ok  boolean NOT NULL,
  erros       text[] NOT NULL DEFAULT '{}',
  ativa       boolean NOT NULL DEFAULT false,
  alertado    boolean NOT NULL DEFAULT false, -- alerta de versão inválida já enviado
  criado_em   timestamptz NOT NULL DEFAULT now(),
  ativada_em  timestamptz,
  CONSTRAINT kb_ativa_exige_contrato CHECK (NOT ativa OR titulos_ok)
);
CREATE UNIQUE INDEX kb_versions_uma_ativa ON kb_versions (ativa) WHERE ativa;

-- Regista uma versão e, se cumprir o contrato, ativa-a (desativando a
-- anterior). Se o hash já existe e é válido mas não está ativo (o Doc
-- voltou a um texto anterior), reativa essa versão.
CREATE OR REPLACE FUNCTION registar_kb(
  p_hash text, p_conteudo text, p_origem text, p_titulos_ok boolean, p_erros text[] DEFAULT '{}'
) RETURNS TABLE (kb_id bigint, nova boolean, ativada boolean)
LANGUAGE plpgsql AS $$
DECLARE
  v_id    bigint;
  v_ativa boolean;
BEGIN
  -- Duas execuções do kb-sync ao mesmo tempo não podem ativar versões diferentes.
  PERFORM pg_advisory_xact_lock(hashtext('kb_versions'));

  SELECT k.id, k.ativa INTO v_id, v_ativa FROM kb_versions k WHERE k.hash = p_hash;

  IF v_id IS NULL THEN
    INSERT INTO kb_versions (hash, conteudo, origem, titulos_ok, erros)
    VALUES (p_hash, p_conteudo, p_origem, p_titulos_ok, coalesce(p_erros, '{}'))
    RETURNING id INTO v_id;
    nova := true;
    v_ativa := false;
  ELSE
    nova := false;
  END IF;

  ativada := false;
  IF NOT v_ativa AND (SELECT k.titulos_ok FROM kb_versions k WHERE k.id = v_id) THEN
    UPDATE kb_versions SET ativa = false WHERE ativa;
    UPDATE kb_versions SET ativa = true, ativada_em = now() WHERE id = v_id;
    ativada := true;
  END IF;

  kb_id := v_id;
  RETURN NEXT;
END;
$$;


-- ---------------------------------------------------------------------------
-- turns: um registo por mensagem do visitante (incluindo as bloqueadas).
-- session_id é texto e não uuid: os pedidos com session_id inválido
-- também ficam registados.
-- ---------------------------------------------------------------------------
CREATE TABLE turns (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id          text NOT NULL CHECK (length(session_id) <= 100),
  canal               text NOT NULL,
  schema_version      integer NOT NULL,
  texto               text,
  resposta            text,
  guarda              text,                       -- motivo de bloqueio; null = passou
  regras              text[] NOT NULL DEFAULT '{}', -- regras de quarentena acionadas
  tools               jsonb NOT NULL DEFAULT '[]',
  tokens_entrada_est  integer,
  tokens_saida_est    integer,
  custo_estimado_eur  numeric(12, 6) NOT NULL DEFAULT 0,
  kb_hash             text,
  modelo              text,
  latencia_ms         integer,
  fallback            boolean NOT NULL DEFAULT false,
  cta_usada           boolean NOT NULL DEFAULT false,
  resposta_cortada    boolean NOT NULL DEFAULT false,
  links_removidos     text[] NOT NULL DEFAULT '{}',
  pt_br               text[] NOT NULL DEFAULT '{}', -- marcadores de português do Brasil
  recebido_em         timestamptz,
  criado_em           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX turns_sessao ON turns (session_id, criado_em);
CREATE INDEX turns_criado_em ON turns (criado_em);
CREATE INDEX turns_quarentena ON turns (session_id, criado_em) WHERE guarda = 'quarentena';

-- Custo estimado acumulado hoje (kill switch).
CREATE OR REPLACE FUNCTION custo_hoje(p_fuso text DEFAULT 'Europe/Lisbon') RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(custo_estimado_eur), 0) FROM turns WHERE criado_em >= inicio_do_dia(p_fuso);
$$;

-- Estado da sessão que as guardas de conteúdo e o pós-processamento precisam.
CREATE OR REPLACE FUNCTION estado_sessao(p_session text, p_bloqueio_minutos integer)
RETURNS TABLE (quarentenas_recentes integer, ctas_anteriores integer)
LANGUAGE sql STABLE AS $$
  SELECT
    (count(*) FILTER (WHERE guarda = 'quarentena'
                        AND criado_em > now() - make_interval(mins => p_bloqueio_minutos)))::integer,
    (count(*) FILTER (WHERE cta_usada))::integer
  FROM turns
  WHERE session_id = left(p_session, 100);
$$;


-- ---------------------------------------------------------------------------
-- rate_limits: contadores por janela. Chaves distintas para minuto e dia,
-- porque à meia-noite as duas janelas coincidem.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  chave     text NOT NULL,
  janela    timestamptz NOT NULL,
  contagem  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (chave, janela)
);
CREATE INDEX rate_limits_janela ON rate_limits (janela);

-- Conta o pedido atual e devolve as contagens já com ele incluído.
-- O teto global junta todos os canais públicos: protege o custo, que é um só.
CREATE OR REPLACE FUNCTION registar_pedido(p_session text, p_fuso text DEFAULT 'Europe/Lisbon')
RETURNS TABLE (sessao_min integer, sessao_dia integer, global_min integer, global_dia integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_sessao text := left(coalesce(p_session, ''), 100);
  v_min    timestamptz := date_trunc('minute', now());
  v_dia    timestamptz := inicio_do_dia(p_fuso);
BEGIN
  RETURN QUERY
  WITH ins AS (
    INSERT INTO rate_limits AS r (chave, janela, contagem) VALUES
      ('sessao_min:' || v_sessao, v_min, 1),
      ('sessao_dia:' || v_sessao, v_dia, 1),
      ('global_min',             v_min, 1),
      ('global_dia',             v_dia, 1)
    ON CONFLICT (chave, janela) DO UPDATE SET contagem = r.contagem + 1
    RETURNING r.chave, r.contagem
  )
  SELECT
    max(ins.contagem) FILTER (WHERE ins.chave = 'sessao_min:' || v_sessao),
    max(ins.contagem) FILTER (WHERE ins.chave = 'sessao_dia:' || v_sessao),
    max(ins.contagem) FILTER (WHERE ins.chave = 'global_min'),
    max(ins.contagem) FILTER (WHERE ins.chave = 'global_dia')
  FROM ins;
END;
$$;


-- ---------------------------------------------------------------------------
-- leads: um por conversa (session_id). Gravado sempre; o Notion só recebe
-- leads com pelo menos um contacto válido.
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id        text NOT NULL UNIQUE CHECK (length(session_id) <= 100),
  nome              text,
  empresa           text,
  setor             text,
  problema          text,
  resumo            text,
  email             text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  telefone          text CHECK (telefone IS NULL OR telefone ~ '^\+[1-9][0-9]{7,14}$'),
  notion_page_id    text,
  crm_existente     boolean NOT NULL DEFAULT false,
  crm_paginas       jsonb NOT NULL DEFAULT '[]',  -- páginas encontradas nos CRMs (só leitura)
  sync_estado       text NOT NULL DEFAULT 'sem_contacto'
                    CHECK (sync_estado IN ('sem_contacto', 'pendente', 'sincronizado', 'falhado')),
  sync_tentativas   integer NOT NULL DEFAULT 0,
  sync_proxima_em   timestamptz,
  sync_ultimo_erro  text,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_pendentes ON leads (sync_proxima_em) WHERE sync_estado = 'pendente';
CREATE INDEX leads_email ON leads (email) WHERE email IS NOT NULL;
CREATE INDEX leads_telefone ON leads (telefone) WHERE telefone IS NOT NULL;
CREATE TRIGGER leads_atualizado_em BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION marcar_atualizado_em();


-- ---------------------------------------------------------------------------
-- handoffs: avisos ao humano. Um por (sessão, motivo); as chamadas
-- repetidas não enviam outro aviso, mas ficam contadas em "repeticoes".
-- ---------------------------------------------------------------------------
CREATE TABLE handoffs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      text NOT NULL CHECK (length(session_id) <= 100),
  motivo          text NOT NULL CHECK (motivo IN ('lead_qualificado', 'pede_humano', 'reclamacao', 'outro')),
  resumo          text NOT NULL,
  lead_id         bigint REFERENCES leads (id) ON DELETE SET NULL,
  crm_existente   boolean NOT NULL DEFAULT false,
  discord_estado  text NOT NULL DEFAULT 'pendente'
                  CHECK (discord_estado IN ('pendente', 'enviado', 'falhado')),
  discord_erro    text,
  repeticoes      integer NOT NULL DEFAULT 0,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  enviado_em      timestamptz,
  UNIQUE (session_id, motivo)
);

-- Regista o pedido de aviso. "enviar" só é true na primeira vez para o par
-- (sessão, motivo): é isto que torna o avisar_humano idempotente.
CREATE OR REPLACE FUNCTION registar_handoff(p_session text, p_motivo text, p_resumo text)
RETURNS TABLE (handoff_id bigint, enviar boolean)
LANGUAGE sql AS $$
  INSERT INTO handoffs AS h (session_id, motivo, resumo, lead_id, crm_existente)
  SELECT p_session, p_motivo, p_resumo, l.id, coalesce(l.crm_existente, false)
  FROM (SELECT 1) AS um
  LEFT JOIN leads l ON l.session_id = p_session
  ON CONFLICT (session_id, motivo) DO UPDATE SET repeticoes = h.repeticoes + 1
  RETURNING h.id, (h.repeticoes = 0);
$$;


-- ---------------------------------------------------------------------------
-- errors: erros dos workflows (Error Trigger ou chamadas explícitas, como
-- as falhas de logging com "continue on fail"). A mensagem pode conter
-- texto de visitantes: fica aqui, nunca vai para o Discord.
-- ---------------------------------------------------------------------------
CREATE TABLE errors (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origem         text NOT NULL CHECK (origem IN ('error_trigger', 'registar_erro')),
  workflow_id    text,
  workflow_nome  text,
  no             text,
  tipo           text,
  mensagem       text,
  execution_id   text,
  execution_url  text,
  alertado       boolean NOT NULL DEFAULT false,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX errors_workflow ON errors (workflow_id, criado_em);

-- Grava o erro e decide se há alerta: no máximo um por workflow em cada
-- janela de p_janela_minutos (anti-spam).
CREATE OR REPLACE FUNCTION registar_erro(
  p_origem text, p_workflow_id text, p_workflow_nome text, p_no text, p_tipo text,
  p_mensagem text, p_execution_id text, p_execution_url text, p_janela_minutos integer DEFAULT 5
) RETURNS TABLE (erro_id bigint, alertar boolean)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('errors:' || coalesce(p_workflow_id, '')));

  alertar := NOT EXISTS (
    SELECT 1 FROM errors e
    WHERE e.workflow_id IS NOT DISTINCT FROM p_workflow_id
      AND e.alertado
      AND e.criado_em > now() - make_interval(mins => p_janela_minutos)
  );

  INSERT INTO errors (origem, workflow_id, workflow_nome, no, tipo, mensagem, execution_id, execution_url, alertado)
  VALUES (p_origem, p_workflow_id, p_workflow_nome, p_no, p_tipo, left(p_mensagem, 4000),
          p_execution_id, p_execution_url, alertar)
  RETURNING id INTO erro_id;

  RETURN NEXT;
END;
$$;


-- ---------------------------------------------------------------------------
-- Limpeza diária (workflow de manutenção). Retenção alinhada com a política
-- de privacidade: 12 meses após o último contacto.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION limpar_dados_antigos() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_rate   integer;
  v_turns  integer;
  v_leads  integer;
  v_erros  integer;
  v_memo   integer := 0;
BEGIN
  DELETE FROM rate_limits WHERE janela < now() - interval '2 days';
  GET DIAGNOSTICS v_rate = ROW_COUNT;

  DELETE FROM turns WHERE criado_em < now() - interval '12 months';
  GET DIAGNOSTICS v_turns = ROW_COUNT;

  DELETE FROM handoffs WHERE criado_em < now() - interval '12 months';
  DELETE FROM leads WHERE atualizado_em < now() - interval '12 months';
  GET DIAGNOSTICS v_leads = ROW_COUNT;

  DELETE FROM errors WHERE criado_em < now() - interval '3 months';
  GET DIAGNOSTICS v_erros = ROW_COUNT;

  -- A memória do agente não tem datas: apaga as sessões sem turnos recentes.
  IF to_regclass('chat_memoria') IS NOT NULL THEN
    EXECUTE 'DELETE FROM chat_memoria m WHERE NOT EXISTS (
               SELECT 1 FROM turns t WHERE t.session_id = m.session_id)';
    GET DIAGNOSTICS v_memo = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('rate_limits', v_rate, 'turns', v_turns, 'leads', v_leads,
                            'errors', v_erros, 'chat_memoria', v_memo);
END;
$$;
