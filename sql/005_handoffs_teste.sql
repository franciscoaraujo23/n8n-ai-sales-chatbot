-- 005_handoffs_teste.sql — avisos de conversas de teste não vão para o Discord.
--
-- A 004 tirou os leads de teste do Notion e do Discord, mas um pedido de
-- "falar com uma pessoa" numa conversa de teste continuava a gerar uma
-- mensagem no canal de leads. Se o lead da conversa é de teste, o aviso fica
-- registado com discord_estado = 'teste' e enviar = false.
--
-- Muda o tipo devolvido por registar_handoff (nova coluna "teste"): o
-- workflow tool-avisar-humano que a lê só pode ser enviado DEPOIS desta
-- migration.

ALTER TABLE handoffs DROP CONSTRAINT handoffs_discord_estado_check;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_discord_estado_check
  CHECK (discord_estado IN ('pendente', 'enviado', 'falhado', 'teste'));

DROP FUNCTION registar_handoff(text, text, text);

CREATE FUNCTION registar_handoff(p_session text, p_motivo text, p_resumo text)
RETURNS TABLE (handoff_id bigint, enviar boolean, teste boolean)
LANGUAGE sql AS $$
  INSERT INTO handoffs AS h (session_id, motivo, resumo, lead_id, crm_existente, discord_estado)
  SELECT p_session, p_motivo, p_resumo, l.id, coalesce(l.crm_existente, false),
         CASE WHEN l.sync_estado = 'teste' THEN 'teste' ELSE 'pendente' END
  FROM (SELECT 1) AS um
  LEFT JOIN leads l ON l.session_id = p_session
  ON CONFLICT (session_id, motivo) DO UPDATE SET repeticoes = h.repeticoes + 1
  RETURNING h.id, (h.repeticoes = 0 AND h.discord_estado <> 'teste'), (h.discord_estado = 'teste');
$$;
