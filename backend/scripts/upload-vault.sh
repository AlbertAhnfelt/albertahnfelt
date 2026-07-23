#!/usr/bin/env bash
# One-time seed of the abbe-vault R2 bucket from the local Obsidian vault.
# Excludes .git/, .obsidian/, images.zip per the vault contract.
# Requires: wrangler logged in, R2 enabled, bucket created.
set -euo pipefail

VAULT_DIR="${1:-$HOME/Documents/albertahnfelt-vault}"
BUCKET="abbe-vault"

cd "$VAULT_DIR"
count=0
while IFS= read -r -d '' file; do
  key="${file#./}"
  echo "put $key"
  wrangler r2 object put "$BUCKET/$key" --file "$file" --remote >/dev/null
  count=$((count + 1))
done < <(find . -type f \
  ! -path './.git/*' ! -path './.obsidian/*' ! -name 'images.zip' \
  ! -name '.DS_Store' -print0)

echo "Uploaded $count files to $BUCKET."
