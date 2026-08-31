#!/usr/bin/env bash
set -euo pipefail

product_dir="$(cd "$(dirname "$0")/.." && pwd)"
corpus_dir="$product_dir/testdata/external"
manifest="$corpus_dir/manifest.tsv"
port="${TEST_PORT:-39090}"
base_url="http://127.0.0.1:$port"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${TEST_BASE_URL:-}" != "" ]]; then
  base_url="$TEST_BASE_URL"
else
  test -x "$product_dir/target/release/anydoc-rag" || {
    printf 'missing release binary; run cargo build --release first\n' >&2
    exit 1
  }
  PORT="$port" "$product_dir/target/release/anydoc-rag" \
    >"$product_dir/target/corpus-server.log" 2>&1 &
  server_pid="$!"
  for _ in $(seq 1 50); do
    curl --fail --silent "$base_url/api/runtime" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl --fail --silent "$base_url/api/runtime" >/dev/null
fi

failures=0
passed=0
printf '%-28s %-8s %-8s %s\n' 'sample' 'format' 'status' 'markdown chars'

while IFS=$'\t' read -r id file_name expected_format expected source_url github_api_url expected_text; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  file="$corpus_dir/files/$file_name"
  response="$(mktemp)"
  status="$(curl --silent --show-error --output "$response" --write-out '%{http_code}' \
    --form "file=@$file" --form mode=rag --form ocr=reject \
    --form max_chars=1200 --form overlap=120 \
    "$base_url/api/convert" || true)"

  actual_format="$(jq -r '.format // ""' "$response" 2>/dev/null || true)"
  markdown_chars="$(jq -r '.markdown | length' "$response" 2>/dev/null || true)"
  markdown="$(jq -r '.markdown // ""' "$response" 2>/dev/null || true)"
  chunks="$(jq -r '.rag.chunks | length' "$response" 2>/dev/null || true)"
  ok="$(jq -r '.ok // false' "$response" 2>/dev/null || true)"

  error_code="$(jq -r '.code // ""' "$response" 2>/dev/null || true)"

  if [[ "$expected" == "success" && "$status" == "200" && "$ok" == "true" \
        && "$actual_format" == "$expected_format" \
        && "$markdown_chars" =~ ^[0-9]+$ && "$markdown_chars" -gt 0 \
        && "$chunks" =~ ^[0-9]+$ && "$chunks" -gt 0 \
        && -n "$expected_text" && "$markdown" == *"$expected_text"* ]]; then
    printf '%-28s %-8s %-8s %s\n' "$id" "$actual_format" 'PASS' "$markdown_chars"
    passed=$((passed + 1))
  elif [[ "$expected" != "success" && "$status" == "422" && "$error_code" == "$expected" ]]; then
    printf '%-28s %-8s %-8s %s\n' "$id" "$expected_format" 'XFAIL' "$error_code"
    passed=$((passed + 1))
  else
    printf '%-28s %-8s %-8s %s\n' "$id" "${actual_format:--}" 'FAIL' "HTTP $status"
    jq -c '{ok, format, code, error, markdown_chars: (.markdown | length), chunks: (.rag.chunks | length)}' \
      "$response" 2>/dev/null || sed -n '1,5p' "$response"
    failures=$((failures + 1))
  fi
  rm -f "$response"
done < "$manifest"

printf '\nresult: %s passed, %s failed\n' "$passed" "$failures"
test "$failures" -eq 0
