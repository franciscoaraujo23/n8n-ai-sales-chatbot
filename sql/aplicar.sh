#!/usr/bin/env bash
# Aplica as migrations pendentes à base "chatbot", como utilizador "chatbot".
# Corre na VPS, na pasta do docker compose (o Postgres não está exposto).
#
# Uso:
#   ./aplicar.sh            aplica as pendentes
#   ./aplicar.sh --estado   só lista o que está aplicado e o que falta
#
# Variáveis (opcionais):
#   COMPOSE_DIR  pasta do docker-compose.yml   (por omissão: a atual)
#   PG_SERVICE   nome do serviço do Postgres   (por omissão: postgres)
#
# Cada migration corre numa única transação, junto com o registo em
# schema_migrations: ou fica toda aplicada, ou não fica nada.
set -euo pipefail

PASTA_SQL="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$PWD}"
PG_SERVICE="${PG_SERVICE:-postgres}"

psql_chatbot() {
  (cd "$COMPOSE_DIR" && docker compose exec -T "$PG_SERVICE" \
    psql -X -q -U chatbot -d chatbot -v ON_ERROR_STOP=1 "$@")
}

psql_chatbot -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  versao text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())" >/dev/null

aplicadas="$(psql_chatbot -tA -c "SELECT versao FROM schema_migrations")"
pendentes=()
for f in "$PASTA_SQL"/[0-9][0-9][0-9]_*.sql; do
  v="$(basename "$f" .sql)"
  if grep -qxF "$v" <<<"$aplicadas"; then
    echo "  aplicada  $v"
  else
    echo "  pendente  $v"
    pendentes+=("$f")
  fi
done

if [[ "${1:-}" == "--estado" ]]; then exit 0; fi
if [[ ${#pendentes[@]} -eq 0 ]]; then echo "Nada a aplicar."; exit 0; fi

for f in "${pendentes[@]}"; do
  v="$(basename "$f" .sql)"
  echo "A aplicar $v…"
  {
    echo "BEGIN;"
    cat "$f"
    echo
    echo "INSERT INTO schema_migrations (versao) VALUES ('$v');"
    echo "COMMIT;"
  } | psql_chatbot
  echo "  ok"
done
