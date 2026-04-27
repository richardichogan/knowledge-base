#!/usr/bin/env bash
# =============================================================================
# migrate-data-to-prod.sh
#
# Copies all user-created data from the local dev PostgreSQL database to the
# production Azure PostgreSQL database.
#
# Tables copied:
#   • projects     — project definitions
#   • notes        — user-written notes
#   • tasks        — user tasks
#   • kb_images    — captured images (metadata only; blobs live in Azure Storage)
#   • global_tags  — tag registry
#
# Tables NOT copied (repopulate automatically via sync):
#   • content_items, sync_state, conversation_*, write_action_proposals
#
# Usage:
#   PROD_DATABASE_URL="postgresql://khadmin:...@knowledge-hub-db.postgres..." \
#     bash scripts/migrate-data-to-prod.sh
#
# Requirements: psql installed locally, local DB at postgresql://localhost/knowledgehub
# =============================================================================

set -euo pipefail

LOCAL_DB="${LOCAL_DATABASE_URL:-postgresql://localhost:5432/knowledgehub}"
PROD_DB="${PROD_DATABASE_URL:-}"

info()    { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m    $*"; }
die()     { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

[[ -z "$PROD_DB" ]] && die "PROD_DATABASE_URL is not set. Export it before running."

TABLES=(projects notes tasks kb_images global_tags)
DUMP_FILE="/tmp/knowledge-hub-user-data.sql"

info "Dumping user data from local DB: $LOCAL_DB"
pg_dump \
  --no-owner \
  --no-acl \
  --disable-triggers \
  --data-only \
  $(printf -- '--table=%s ' "${TABLES[@]}") \
  "$LOCAL_DB" \
  > "$DUMP_FILE"

# Count rows exported for confidence
for table in "${TABLES[@]}"; do
  count=$(psql "$LOCAL_DB" -tAc "SELECT COUNT(*) FROM $table" 2>/dev/null || echo "?")
  info "  $table: $count rows"
done

success "Dump written to $DUMP_FILE"

# Truncate prod tables in reverse FK order, then restore
info "Restoring to production DB..."
psql "$PROD_DB" <<'SQL'
  TRUNCATE TABLE tasks CASCADE;
  TRUNCATE TABLE kb_images CASCADE;
  TRUNCATE TABLE notes CASCADE;
  TRUNCATE TABLE global_tags CASCADE;
  TRUNCATE TABLE projects CASCADE;
SQL

psql "$PROD_DB" < "$DUMP_FILE"

success "Data migration complete."
info "Row counts on production:"
for table in "${TABLES[@]}"; do
  count=$(psql "$PROD_DB" -tAc "SELECT COUNT(*) FROM $table" 2>/dev/null || echo "?")
  info "  $table: $count rows"
done

rm -f "$DUMP_FILE"
