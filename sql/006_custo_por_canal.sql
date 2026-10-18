-- 006_custo_por_canal.sql — kill switch com um orçamento por canal.
--
-- Os evals e o site partilhavam o mesmo custo do dia: uma bateria de evals a
-- meio do dia podia fechar o chat aos visitantes até à meia-noite. O custo
-- passa a ser contado só no canal do turno, e cada canal tem o seu teto em
-- src/config.js (limites.custoDiarioMaxEur).
--
-- Compatível com o chat-core atual: p_canal é opcional e, sem ele, conta
-- todos os canais como antes. Aplicar ANTES de enviar o chat-core novo.

DROP FUNCTION contexto_turno(text, integer, integer, text);
DROP FUNCTION custo_hoje(text);

-- Custo estimado acumulado hoje; só do canal indicado (null = todos).
CREATE FUNCTION custo_hoje(p_fuso text DEFAULT 'Europe/Lisbon', p_canal text DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(custo_estimado_eur), 0) FROM turns
  WHERE criado_em >= inicio_do_dia(p_fuso) AND (p_canal IS NULL OR canal = p_canal);
$$;

-- Tudo o que o núcleo precisa antes de decidir se chama o LLM.
-- Devolve sempre uma linha; kb_hash/kb_conteudo a null = não há versão ativa.
CREATE FUNCTION contexto_turno(
  p_session text, p_bloqueio_minutos integer, p_mensagens integer,
  p_fuso text DEFAULT 'Europe/Lisbon', p_canal text DEFAULT NULL
) RETURNS TABLE (
  quarentenas_recentes integer, ctas_anteriores integer, custo_hoje numeric, historico_chars integer,
  lead_nome text, lead_email text, lead_telefone text, kb_hash text, kb_conteudo text
)
LANGUAGE sql STABLE AS $$
  SELECT e.quarentenas_recentes, e.ctas_anteriores, custo_hoje(p_fuso, p_canal),
         tamanho_memoria(left(p_session, 100), p_mensagens),
         l.nome, l.email, l.telefone, k.hash, k.conteudo
  FROM estado_sessao(p_session, p_bloqueio_minutos) AS e
  LEFT JOIN leads l ON l.session_id = left(p_session, 100)
  LEFT JOIN kb_versions k ON k.ativa;
$$;
