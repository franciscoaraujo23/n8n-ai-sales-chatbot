-- 003_turnos.sql — leitura do contexto do turno e gravação do turno.
--
-- O chat-core faz uma única query antes do LLM (contexto_turno) e uma
-- depois (registar_turno). Menos nós no n8n, lógica testada em SQL.

-- Tamanho (em caracteres) das últimas mensagens da memória do agente, para
-- estimar o custo. A tabela chat_memoria é criada pelo nó do n8n na
-- primeira mensagem; até lá, o tamanho é 0.
CREATE OR REPLACE FUNCTION tamanho_memoria(p_session text, p_mensagens integer) RETURNS integer
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v integer := 0;
BEGIN
  IF to_regclass('chat_memoria') IS NULL THEN
    RETURN 0;
  END IF;
  EXECUTE 'SELECT coalesce(sum(length(message::text)), 0)::integer
           FROM (SELECT message FROM chat_memoria WHERE session_id = $1 ORDER BY id DESC LIMIT $2) AS m'
    INTO v USING p_session, p_mensagens;
  RETURN v;
END;
$$;

-- Tudo o que o núcleo precisa antes de decidir se chama o LLM.
-- Devolve sempre uma linha; kb_hash/kb_conteudo a null = não há versão ativa.
CREATE OR REPLACE FUNCTION contexto_turno(
  p_session text, p_bloqueio_minutos integer, p_mensagens integer, p_fuso text DEFAULT 'Europe/Lisbon'
) RETURNS TABLE (
  quarentenas_recentes integer, ctas_anteriores integer, custo_hoje numeric, historico_chars integer,
  lead_nome text, lead_email text, lead_telefone text, kb_hash text, kb_conteudo text
)
LANGUAGE sql STABLE AS $$
  SELECT e.quarentenas_recentes, e.ctas_anteriores, custo_hoje(p_fuso),
         tamanho_memoria(left(p_session, 100), p_mensagens),
         l.nome, l.email, l.telefone, k.hash, k.conteudo
  FROM estado_sessao(p_session, p_bloqueio_minutos) AS e
  LEFT JOIN leads l ON l.session_id = left(p_session, 100)
  LEFT JOIN kb_versions k ON k.ativa;
$$;

-- Lê um array JSON de texto como text[] (null ou não-array = vazio).
CREATE OR REPLACE FUNCTION jsonb_para_texto(p jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(p))
              ELSE '{}'::text[] END;
$$;

-- Grava um turno a partir do JSON montado no chat-core (ou no guard-trafego).
CREATE OR REPLACE FUNCTION registar_turno(p jsonb) RETURNS TABLE (turno_id bigint)
LANGUAGE sql AS $$
  INSERT INTO turns (
    session_id, canal, schema_version, texto, resposta, guarda, regras, tools,
    tokens_entrada_est, tokens_saida_est, custo_estimado_eur, kb_hash, modelo, latencia_ms,
    fallback, cta_usada, resposta_cortada, links_removidos, pt_br, recebido_em
  ) VALUES (
    left(coalesce(p->>'session_id', ''), 100),
    coalesce(p->>'canal', 'desconhecido'),
    coalesce((p->>'schema_version')::integer, 0),
    left(p->>'texto', 4000),
    p->>'resposta',
    p->>'guarda',
    jsonb_para_texto(p->'regras'),
    CASE WHEN jsonb_typeof(p->'tools') = 'array' THEN p->'tools' ELSE '[]'::jsonb END,
    (p->>'tokens_entrada_est')::integer,
    (p->>'tokens_saida_est')::integer,
    coalesce((p->>'custo_estimado_eur')::numeric, 0),
    p->>'kb_hash',
    p->>'modelo',
    (p->>'latencia_ms')::integer,
    coalesce((p->>'fallback')::boolean, false),
    coalesce((p->>'cta_usada')::boolean, false),
    coalesce((p->>'resposta_cortada')::boolean, false),
    jsonb_para_texto(p->'links_removidos'),
    jsonb_para_texto(p->'pt_br'),
    coalesce((p->>'recebido_em')::timestamptz, now())
  )
  RETURNING id;
$$;
