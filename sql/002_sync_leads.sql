-- 002_sync_leads.sql — registo de leads e sincronização com o Notion.
--
-- A tool registar_lead e a nova tentativa agendada usam a mesma cadeia de
-- sincronização. Uma reserva com prazo (sync_proxima_em no futuro) garante
-- que as duas nunca tratam o mesmo lead ao mesmo tempo, o que podia criar
-- duas páginas no Notion para a mesma pessoa.

-- Quando a reserva foi feita: se os dados mudarem depois disso, o
-- resultado da sincronização já não corresponde aos dados atuais.
ALTER TABLE leads ADD COLUMN sync_reservado_em timestamptz;

-- atualizado_em passa a refletir só mudanças aos dados do lead (é o
-- "último contacto" da retenção), não as tentativas de sincronização.
DROP TRIGGER leads_atualizado_em ON leads;
CREATE TRIGGER leads_atualizado_em
  BEFORE UPDATE OF nome, empresa, setor, problema, resumo, email, telefone ON leads
  FOR EACH ROW EXECUTE FUNCTION marcar_atualizado_em();


-- Upsert por session_id. Campos a null não apagam o que já existe.
-- Com contacto válido, o lead fica pendente para sincronizar já, salvo se
-- estiver reservado por outra execução (essa reserva é respeitada).
CREATE OR REPLACE FUNCTION registar_lead(p jsonb) RETURNS SETOF leads
LANGUAGE sql AS $$
  INSERT INTO leads AS l (session_id, nome, empresa, setor, problema, resumo, email, telefone,
                          sync_estado, sync_proxima_em)
  VALUES (
    p->>'session_id',
    nullif(p->>'nome', ''), nullif(p->>'empresa', ''), nullif(p->>'setor', ''),
    nullif(p->>'problema', ''), nullif(p->>'resumo', ''),
    nullif(p->>'email', ''), nullif(p->>'telefone', ''),
    CASE WHEN nullif(p->>'email', '') IS NOT NULL OR nullif(p->>'telefone', '') IS NOT NULL
         THEN 'pendente' ELSE 'sem_contacto' END,
    now()
  )
  ON CONFLICT (session_id) DO UPDATE SET
    nome     = coalesce(EXCLUDED.nome, l.nome),
    empresa  = coalesce(EXCLUDED.empresa, l.empresa),
    setor    = coalesce(EXCLUDED.setor, l.setor),
    problema = coalesce(EXCLUDED.problema, l.problema),
    resumo   = coalesce(EXCLUDED.resumo, l.resumo),
    email    = coalesce(EXCLUDED.email, l.email),
    telefone = coalesce(EXCLUDED.telefone, l.telefone),
    sync_estado = CASE
      WHEN coalesce(EXCLUDED.email, l.email, EXCLUDED.telefone, l.telefone) IS NULL THEN 'sem_contacto'
      ELSE 'pendente' END,
    sync_tentativas = 0,
    sync_ultimo_erro = NULL,
    sync_proxima_em = CASE
      WHEN l.sync_estado = 'pendente' AND l.sync_proxima_em > now() THEN l.sync_proxima_em
      ELSE now() END
  RETURNING l.*;
$$;


-- Reserva leads pendentes para sincronizar (10 minutos de prazo).
-- p_session preenchido: só esse lead (chamada da tool).
-- p_session a null: os pendentes vencidos (nova tentativa agendada).
CREATE OR REPLACE FUNCTION reservar_leads_sync(p_session text, p_limite integer DEFAULT 10)
RETURNS SETOF leads
LANGUAGE sql AS $$
  UPDATE leads SET
    sync_proxima_em   = now() + interval '10 minutes',
    sync_reservado_em = now()
  WHERE id IN (
    SELECT id FROM leads
    WHERE sync_estado = 'pendente'
      AND sync_proxima_em <= now()
      AND (p_session IS NULL OR session_id = p_session)
    ORDER BY sync_proxima_em
    LIMIT p_limite
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;


-- Fecha uma sincronização. p: {id, ok, notion_page_id, crm_existente,
-- crm_paginas, erro}. Em falha, backoff de 5 min, 30 min, 2 h e 12 h; à
-- quinta falha fica "falhado". Se os dados mudaram depois da reserva, volta
-- a pendente para sincronizar outra vez (a página já existe: será
-- atualizada, nunca criada de novo).
CREATE OR REPLACE FUNCTION concluir_sync_lead(p jsonb) RETURNS SETOF leads
LANGUAGE plpgsql AS $$
DECLARE
  v_ok        boolean := coalesce((p->>'ok')::boolean, false);
  v_backoff   interval[] := ARRAY[interval '5 minutes', interval '30 minutes',
                                  interval '2 hours', interval '12 hours'];
BEGIN
  RETURN QUERY
  UPDATE leads l SET
    notion_page_id = coalesce(nullif(p->>'notion_page_id', ''), l.notion_page_id),
    crm_existente  = coalesce((p->>'crm_existente')::boolean, l.crm_existente),
    crm_paginas    = CASE WHEN jsonb_typeof(p->'crm_paginas') = 'array' THEN p->'crm_paginas'
                          ELSE l.crm_paginas END,
    sync_estado = CASE
      WHEN v_ok AND l.atualizado_em > l.sync_reservado_em THEN 'pendente'
      WHEN v_ok THEN 'sincronizado'
      WHEN l.sync_tentativas + 1 > array_length(v_backoff, 1) THEN 'falhado'
      ELSE 'pendente' END,
    sync_tentativas = CASE WHEN v_ok THEN 0 ELSE l.sync_tentativas + 1 END,
    sync_proxima_em = CASE
      WHEN v_ok AND l.atualizado_em > l.sync_reservado_em THEN now()
      WHEN v_ok THEN NULL
      WHEN l.sync_tentativas + 1 > array_length(v_backoff, 1) THEN NULL
      ELSE now() + v_backoff[l.sync_tentativas + 1] END,
    sync_ultimo_erro = CASE WHEN v_ok THEN NULL ELSE left(p->>'erro', 1000) END
  WHERE l.id = (p->>'id')::bigint
  RETURNING l.*;
END;
$$;
