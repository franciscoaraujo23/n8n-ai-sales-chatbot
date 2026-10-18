-- 004_leads_teste.sql — leads com email de teste não saem do Postgres.
--
-- Os evals (e visitantes que escrevem emails de exemplo) criavam páginas no
-- Notion e avisos no Discord. Um lead cujo email final é de um domínio de
-- teste fica com sync_estado = 'teste': não é sincronizado, não avisa a
-- equipa e as novas tentativas agendadas não lhe pegam (só leem 'pendente').
-- A lista de domínios vem de src/config.js, no parâmetro p.dominios_teste.

ALTER TABLE leads DROP CONSTRAINT leads_sync_estado_check;
ALTER TABLE leads ADD CONSTRAINT leads_sync_estado_check
  CHECK (sync_estado IN ('sem_contacto', 'pendente', 'sincronizado', 'falhado', 'teste'));

-- O email é de um dos domínios de teste?
CREATE OR REPLACE FUNCTION email_de_teste(p_email text, p_dominios jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_email IS NOT NULL
     AND jsonb_typeof(p_dominios) = 'array'
     AND lower(split_part(p_email, '@', 2)) IN (SELECT lower(jsonb_array_elements_text(p_dominios)));
$$;

CREATE OR REPLACE FUNCTION registar_lead(p jsonb) RETURNS SETOF leads
LANGUAGE sql AS $$
  INSERT INTO leads AS l (session_id, nome, empresa, setor, problema, resumo, email, telefone,
                          sync_estado, sync_proxima_em)
  VALUES (
    p->>'session_id',
    nullif(p->>'nome', ''), nullif(p->>'empresa', ''), nullif(p->>'setor', ''),
    nullif(p->>'problema', ''), nullif(p->>'resumo', ''),
    nullif(p->>'email', ''), nullif(p->>'telefone', ''),
    CASE
      WHEN email_de_teste(nullif(p->>'email', ''), p->'dominios_teste') THEN 'teste'
      WHEN nullif(p->>'email', '') IS NOT NULL OR nullif(p->>'telefone', '') IS NOT NULL THEN 'pendente'
      ELSE 'sem_contacto' END,
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
    -- Decide com o email FINAL: uma chamada só com telefone não "limpa" um lead de teste.
    sync_estado = CASE
      WHEN email_de_teste(coalesce(EXCLUDED.email, l.email), p->'dominios_teste') THEN 'teste'
      WHEN coalesce(EXCLUDED.email, l.email, EXCLUDED.telefone, l.telefone) IS NULL THEN 'sem_contacto'
      ELSE 'pendente' END,
    sync_tentativas = 0,
    sync_ultimo_erro = NULL,
    sync_proxima_em = CASE
      WHEN l.sync_estado = 'pendente' AND l.sync_proxima_em > now() THEN l.sync_proxima_em
      ELSE now() END
  RETURNING l.*;
$$;
