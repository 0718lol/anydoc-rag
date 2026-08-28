#!/usr/bin/env bash
set -euo pipefail

product_dir="$(cd "$(dirname "$0")/.." && pwd)"
corpus_dir="$product_dir/testdata/external"
manifest="$corpus_dir/manifest.tsv"

mkdir -p "$corpus_dir/files"

while IFS=$'\t' read -r id file_name format expected source_url github_api_url; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  destination="$corpus_dir/files/$file_name"
  printf 'fetch %-28s %s\n' "$id" "$file_name"
  if ! curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time 30 "$github_api_url" \
    | jq -er '.content' | tr -d '\n' | base64 -d > "$destination.part"; then
    printf 'GitHub API failed, falling back to raw URL\n' >&2
    curl --fail --location --retry 2 --retry-all-errors \
      --connect-timeout 10 --max-time 60 \
      --output "$destination.part" "$source_url"
  fi
  test -s "$destination.part"
  mv "$destination.part" "$destination"
done < "$manifest"

(cd "$corpus_dir/files" && sha256sum * | sort) > "$corpus_dir/SHA256SUMS"
printf 'downloaded %s files\n' "$(find "$corpus_dir/files" -maxdepth 1 -type f | wc -l)"
