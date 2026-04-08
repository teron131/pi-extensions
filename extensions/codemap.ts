/**
 * Codemap Extension
 *
 * Exposes the codemap syntax-relationship analyzer as a custom Pi tool.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    type TruncationResult,
    truncateHead,
    withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MODULE_STATS_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail

MODULE_PATH="\${1:-.}"
TS_GLOB='**/*.{ts,tsx}'
JS_GLOB='**/*.{js,jsx}'
PY_GLOB='**/*.py'
IDENT_RE='^[A-Za-z_][A-Za-z0-9_]*$'
IDENT_TOKEN_RE='[A-Za-z_][A-Za-z0-9_]*'
LOCAL_TSJS_RE='^(\./|\.\./)'
LOCAL_PY_RE='^\.'
TOP_RELATION_LIMIT=10
NAME_LIMIT=40
USAGE_LIMIT=12

if [[ ! -d "$MODULE_PATH" ]]; then
  echo "Error: module path does not exist or is not a directory: $MODULE_PATH" >&2
  exit 1
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is required." >&2
    exit 2
  fi
}

require_cmd rg
require_cmd sg
require_cmd jq

trim_num() {
  printf "%s" "$1" | tr -cd '0-9'
}

count_nonempty_lines() {
  local values="$1"
  printf "%s\n" "$values" | sed '/^$/d' | wc -l | tr -d ' '
}

count_unique_lines() {
  local values="$1"
  printf "%s\n" "$values" | sed '/^$/d' | sort -u | wc -l | tr -d ' '
}

build_identifier_occurrence_table() {
  local glob="$1"
  rg --no-filename -o --glob "$glob" "$IDENT_TOKEN_RE" "$MODULE_PATH" 2>/dev/null \
    | sort \
    | uniq -c \
    | awk '{ print $2 "\t" $1 }' || true
}

build_ts_js_identifier_occurrence_table() {
  {
    rg --no-filename -o --glob "$TS_GLOB" "$IDENT_TOKEN_RE" "$MODULE_PATH" 2>/dev/null || true
    rg --no-filename -o --glob "$JS_GLOB" "$IDENT_TOKEN_RE" "$MODULE_PATH" 2>/dev/null || true
  } | sort | uniq -c | awk '{ print $2 "\t" $1 }' || true
}

count_sg() {
  local lang="$1"
  local pattern="$2"
  local glob="$3"
  local out
  out="$(
    sg run -p "$pattern" --lang "$lang" "$MODULE_PATH" --globs "$glob" --json=compact 2>/dev/null \
      | jq 'length' 2>/dev/null || true
  )"
  out="$(trim_num "$(printf "%s" "$out" | tail -n1)")"
  if [[ -z "$out" ]]; then
    echo 0
    return
  fi
  echo "$out"
}

count_ts_js() {
  local pattern="$1"
  local ts js
  ts="$(count_sg typescript "$pattern" "$TS_GLOB")"
  js="$(count_sg javascript "$pattern" "$JS_GLOB")"
  echo $((ts + js))
}

sum_counts() {
  local total=0
  local value
  for value in "$@"; do
    total=$((total + value))
  done
  echo "$total"
}

list_sg_names_all() {
  local lang="$1"
  local pattern="$2"
  local glob="$3"
  local key="\${4:-NAME}"
  sg run -p "$pattern" --lang "$lang" "$MODULE_PATH" --globs "$glob" --json=compact 2>/dev/null \
    | jq -r --arg k "$key" '.[]? | .metaVariables.single[$k].text // empty' 2>/dev/null \
    | sed '/^$/d' \
    | grep -E "$IDENT_RE" || true
}

list_sg_names() {
  local lang="$1"
  local pattern="$2"
  local glob="$3"
  local key="\${4:-NAME}"
  list_sg_names_all "$lang" "$pattern" "$glob" "$key" | sort -u
}

list_sg_values() {
  local lang="$1"
  local pattern="$2"
  local glob="$3"
  local key="\${4:-MOD}"
  sg run -p "$pattern" --lang "$lang" "$MODULE_PATH" --globs "$glob" --json=compact 2>/dev/null \
    | jq -r --arg k "$key" '.[]? | .metaVariables.single[$k].text // empty' 2>/dev/null \
    | sed '/^$/d' || true
}

list_ts_js_names_all() {
  local pattern="$1"
  {
    list_sg_names_all typescript "$pattern" "$TS_GLOB"
    list_sg_names_all javascript "$pattern" "$JS_GLOB"
  }
}

list_ts_js_names() {
  local pattern="$1"
  list_ts_js_names_all "$pattern" | sort -u
}

list_ts_js_values() {
  local pattern="$1"
  local key="\${2:-MOD}"
  {
    list_sg_values typescript "$pattern" "$TS_GLOB" "$key"
    list_sg_values javascript "$pattern" "$JS_GLOB" "$key"
  } | sed '/^$/d'
}

extract_tail_identifiers() {
  local matches="$1"
  local result=""
  local match identifier

  while IFS= read -r match; do
    if [[ -z "$match" ]]; then
      continue
    fi
    identifier="$(printf "%s\n" "$match" | grep -oE "$IDENT_TOKEN_RE" | tail -n1 || true)"
    if [[ -n "$identifier" ]]; then
      result+="\${identifier}"$'\n'
    fi
  done <<< "$matches"

  printf "%s" "$result" | sed '/^$/d' | sort -u
}

list_ts_js_env_names() {
  local matches=""
  matches+="$(rg -o --glob "$TS_GLOB" --glob "$JS_GLOB" 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' "$MODULE_PATH" 2>/dev/null || true)"$'\n'
  matches+="$(rg -o --pcre2 --glob "$TS_GLOB" --glob "$JS_GLOB" 'process\.env\[["'"'"'][A-Za-z_][A-Za-z0-9_]*["'"'"']\]' "$MODULE_PATH" 2>/dev/null || true)"$'\n'
  matches+="$(rg -o --glob "$TS_GLOB" --glob "$JS_GLOB" 'import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*' "$MODULE_PATH" 2>/dev/null || true)"$'\n'
  matches+="$(rg -o --pcre2 --glob "$TS_GLOB" --glob "$JS_GLOB" 'import\.meta\.env\[["'"'"'][A-Za-z_][A-Za-z0-9_]*["'"'"']\]' "$MODULE_PATH" 2>/dev/null || true)"$'\n'
  extract_tail_identifiers "$matches"
}

list_python_env_names() {
  local matches=""
  matches+="$(rg -o --pcre2 --glob "$PY_GLOB" 'os\.getenv\(["'"'"'][A-Za-z_][A-Za-z0-9_]*["'"'"']' "$MODULE_PATH" 2>/dev/null || true)"$'\n'
  matches+="$(rg -o --pcre2 --glob "$PY_GLOB" 'os\.environ\.get\(["'"'"'][A-Za-z_][A-Za-z0-9_]*["'"'"']' "$MODULE_PATH" 2>/dev/null || true)"$'\n'
  matches+="$(rg -o --pcre2 --glob "$PY_GLOB" 'os\.environ\[["'"'"'][A-Za-z_][A-Za-z0-9_]*["'"'"']\]' "$MODULE_PATH" 2>/dev/null || true)"$'\n'
  extract_tail_identifiers "$matches"
}

list_env_file_names() {
  local env_files
  env_files="$(
    find "$MODULE_PATH" -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '*.env.*' \) 2>/dev/null || true
  )"
  if [[ -z "$env_files" ]]; then
    return
  fi

  while IFS= read -r env_file; do
    if [[ -z "$env_file" ]]; then
      continue
    fi
    awk -F= '
      /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=/ {
        key = $1
        sub(/^[[:space:]]*export[[:space:]]+/, "", key)
        gsub(/[[:space:]]+$/, "", key)
        print key
      }
    ' "$env_file"
  done <<< "$env_files" | sed '/^$/d' | sort -u
}

filter_values() {
  local values="$1"
  local pattern="$2"
  local mode="\${3:-include}"
  if [[ -z "$values" ]]; then
    return
  fi

  if [[ "$mode" == "exclude" ]]; then
    printf "%s\n" "$values" | sed '/^$/d' | rg -v "$pattern" || true
    return
  fi

  printf "%s\n" "$values" | sed '/^$/d' | rg "$pattern" || true
}

print_name_block() {
  local title="$1"
  local values="$2"
  local limit="\${3:-$NAME_LIMIT}"
  local count
  count="$(count_nonempty_lines "$values")"
  echo "$title ($count):"
  if [[ "$count" == "0" ]]; then
    echo "  (none)"
    return
  fi
  printf "%s\n" "$values" | sed '/^$/d' | head -n "$limit" | sed 's/^/  - /'
  if [[ "$count" -gt "$limit" ]]; then
    echo "  ... +$((count - limit)) more"
  fi
}

print_relation_block() {
  local title="$1"
  local values="$2"
  local limit="\${3:-$TOP_RELATION_LIMIT}"
  local edge_count unique_count
  edge_count="$(count_nonempty_lines "$values")"
  unique_count="$(count_unique_lines "$values")"
  echo "$title ($edge_count edges, $unique_count unique):"
  if [[ "$edge_count" == "0" ]]; then
    echo "  (none)"
    return
  fi
  printf "%s\n" "$values" | sed '/^$/d' | sort | uniq -c | sort -nr | head -n "$limit"
  if [[ "$unique_count" -gt "$limit" ]]; then
    echo "  ... +$((unique_count - limit)) more unique targets"
  fi
}

lookup_count_in_table() {
  local table="$1"
  local name="$2"
  local count
  count="$(printf "%s\n" "$table" | awk -F'\t' -v name="$name" '$1 == name { print $2; found = 1; exit } END { if (!found) print 0 }')"
  echo "\${count:-0}"
}

build_usage_counts() {
  local names="$1"
  local occurrence_table="$2"
  local results=""
  local name raw

  while IFS= read -r name; do
    if [[ -z "$name" ]]; then
      continue
    fi
    raw="$(lookup_count_in_table "$occurrence_table" "$name")"
    results+="\${raw}"$'\t'"\${name}"$'\n'
  done <<< "$names"

  printf "%s" "$results" | sed '/^$/d'
}

print_usage_distribution_block() {
  local title="$1"
  local values="$2"
  local symbol_count
  symbol_count="$(count_nonempty_lines "$values")"
  echo "$title ($symbol_count symbols):"
  if [[ "$symbol_count" == "0" ]]; then
    echo "  (none)"
    return
  fi
  printf "%s\n" "$values" | awk -F'\t' '
    BEGIN { zero_one = 0; two = 0; three_five = 0; six_plus = 0 }
    NF >= 2 {
      count = $1 + 0
      if (count <= 1) zero_one++
      else if (count == 2) two++
      else if (count <= 5) three_five++
      else six_plus++
    }
    END {
      printf "  0-1 matches: %d\n", zero_one
      printf "  2 matches:   %d\n", two
      printf "  3-5:         %d\n", three_five
      printf "  6+:          %d\n", six_plus
    }
  '
}

print_usage_count_block() {
  local title="$1"
  local values="$2"
  local sort_order="\${3:-asc}"
  local limit="\${4:-$USAGE_LIMIT}"
  local symbol_count sort_args
  symbol_count="$(count_nonempty_lines "$values")"
  echo "$title ($symbol_count symbols):"
  if [[ "$symbol_count" == "0" ]]; then
    echo "  (none)"
    return
  fi

  if [[ "$sort_order" == "desc" ]]; then
    sort_args='-k1,1nr -k2,2'
  else
    sort_args='-k1,1n -k2,2'
  fi

  printf "%s\n" "$values" \
    | sed '/^$/d' \
    | sort $sort_args \
    | head -n "$limit" \
    | awk -F'\t' '{ printf "  %4d  %s\n", $1, $2 }'

  if [[ "$symbol_count" -gt "$limit" ]]; then
    echo "  ... +$((symbol_count - limit)) more"
  fi
}

echo "Module: $MODULE_PATH"
echo

# Filesystem (gitignore-aware via rg)
FILE_LIST="$(rg --files "$MODULE_PATH" 2>/dev/null || true)"
IGNORE_NOTE=""
if [[ -z "$FILE_LIST" ]]; then
  DIR_COUNT=0
  FILE_COUNT=0
  FILE_TYPE_STATS=""
  RAW_FILE_COUNT="$(find "$MODULE_PATH" -type f 2>/dev/null | wc -l | tr -d ' ' || true)"
  if [[ "\${RAW_FILE_COUNT:-0}" != "0" ]]; then
    IGNORE_NOTE="No files matched via rg (likely ignored by .gitignore/.ignore)."
  fi
else
  FILE_COUNT="$(printf "%s\n" "$FILE_LIST" | wc -l | tr -d ' ')"
  DIR_COUNT="$(printf "%s\n" "$FILE_LIST" | xargs -I{} dirname "{}" | sort -u | wc -l | tr -d ' ')"
  FILE_TYPE_STATS="$(
    printf "%s\n" "$FILE_LIST" \
      | awk -F/ '
        {
          file=$NF
          n=split(file, parts, ".")
          ext=(n>1 ? parts[n] : "no_ext")
          count[ext]++
        }
        END {
          for (k in count) printf "%7d  %s\n", count[k], k
        }
      ' \
      | sort -nr
  )"
fi

echo "== Filesystem =="
echo "dirs:  $DIR_COUNT"
echo "files: $FILE_COUNT"
echo
echo "== File Types =="
if [[ -n "$FILE_TYPE_STATS" ]]; then
  echo "$FILE_TYPE_STATS"
else
  echo "      0  (none)"
fi
if [[ -n "$IGNORE_NOTE" ]]; then
  echo
  echo "note: $IGNORE_NOTE"
fi
echo

# AST structural stats
TSJS_FUNC_DECL="$(count_ts_js 'function $NAME($$$) { $$$ }')"
TSJS_ARROW_CONST="$(count_ts_js 'const $NAME = ($$$) => { $$$ }')"
TSJS_ARROW_ASYNC_CONST="$(count_ts_js 'const $NAME = async ($$$) => { $$$ }')"
TSJS_CLASS="$(sum_counts \
  "$(count_ts_js 'class $NAME { $$$ }')" \
  "$(count_ts_js 'class $NAME extends $BASE { $$$ }')")"

TSJS_EXPORTED_VARS="$(sum_counts \
  "$(count_ts_js 'export const $NAME = $VALUE')" \
  "$(count_ts_js 'export let $NAME = $VALUE')" \
  "$(count_ts_js 'export var $NAME = $VALUE')")"
TSJS_EXPORTED_FUNCS="$(count_ts_js 'export function $NAME($$$) { $$$ }')"
TSJS_EXPORTED_CLASSES="$(sum_counts \
  "$(count_ts_js 'export class $NAME { $$$ }')" \
  "$(count_ts_js 'export class $NAME extends $BASE { $$$ }')")"
TSJS_EXPORTED_DEFAULT="$(count_ts_js 'export default $X')"
TS_EXPORTED_TYPES="$(sum_counts \
  "$(count_sg typescript 'export type $NAME = $VALUE' "$TS_GLOB")" \
  "$(count_sg typescript 'export interface $NAME { $$$ }' "$TS_GLOB")")"
TSJS_EXPORTS_TOTAL="$(sum_counts \
  "$TSJS_EXPORTED_VARS" "$TSJS_EXPORTED_FUNCS" "$TSJS_EXPORTED_CLASSES" "$TSJS_EXPORTED_DEFAULT" "$TS_EXPORTED_TYPES")"

PY_FUNC="$(count_sg python 'def $NAME($$$): $$$' "$PY_GLOB")"
PY_ASYNC_FUNC="$(count_sg python 'async def $NAME($$$): $$$' "$PY_GLOB")"
PY_CLASS="$(sum_counts \
  "$(count_sg python 'class $NAME: $$$' "$PY_GLOB")" \
  "$(count_sg python 'class $NAME($BASE): $$$' "$PY_GLOB")")"
PY_EXPORT_ALL="$(count_sg python '__all__ = [$$$]' "$PY_GLOB")"

echo "== AST Stats (TS/JS) =="
echo "functions (decl):           $TSJS_FUNC_DECL"
echo "functions (arrow const):    $TSJS_ARROW_CONST"
echo "functions (arrow async):    $TSJS_ARROW_ASYNC_CONST"
echo "classes:                    $TSJS_CLASS"
echo "exports (total explicit):   $TSJS_EXPORTS_TOTAL"
echo "exported vars:              $TSJS_EXPORTED_VARS"
echo
echo "== AST Stats (Python) =="
echo "functions (def):            $PY_FUNC"
echo "functions (async def):      $PY_ASYNC_FUNC"
echo "classes:                    $PY_CLASS"
echo "__all__ exports:            $PY_EXPORT_ALL"
echo
echo "Note: counts are structural and may be approximate for mixed syntax or broad patterns."
echo

# Symbol inventory
TSJS_FUNC_NAMES="$(
  {
    list_ts_js_names 'function $NAME($$$) { $$$ }'
    list_ts_js_names 'export function $NAME($$$) { $$$ }'
  } | sort -u
)"
TSJS_ARROW_NAMES="$(
  {
    list_ts_js_names 'const $NAME = ($$$) => { $$$ }'
    list_ts_js_names 'const $NAME = async ($$$) => { $$$ }'
    list_ts_js_names 'let $NAME = ($$$) => { $$$ }'
    list_ts_js_names 'let $NAME = async ($$$) => { $$$ }'
    list_ts_js_names 'var $NAME = ($$$) => { $$$ }'
    list_ts_js_names 'var $NAME = async ($$$) => { $$$ }'
    list_ts_js_names 'export const $NAME = ($$$) => { $$$ }'
    list_ts_js_names 'export const $NAME = async ($$$) => { $$$ }'
    list_ts_js_names 'export let $NAME = ($$$) => { $$$ }'
    list_ts_js_names 'export let $NAME = async ($$$) => { $$$ }'
    list_ts_js_names 'export var $NAME = ($$$) => { $$$ }'
    list_ts_js_names 'export var $NAME = async ($$$) => { $$$ }'
  } | sort -u
)"
TSJS_CLASS_NAMES="$(
  {
    list_ts_js_names 'class $NAME { $$$ }'
    list_ts_js_names 'class $NAME extends $BASE { $$$ }'
    list_ts_js_names 'export class $NAME { $$$ }'
    list_ts_js_names 'export class $NAME extends $BASE { $$$ }'
  } | sort -u
)"
TSJS_VAR_NAMES="$(
  {
    list_ts_js_names 'const $NAME = $VALUE'
    list_ts_js_names 'let $NAME = $VALUE'
    list_ts_js_names 'var $NAME = $VALUE'
    list_ts_js_names 'export const $NAME = $VALUE'
    list_ts_js_names 'export let $NAME = $VALUE'
    list_ts_js_names 'export var $NAME = $VALUE'
  } | sort -u
)"
PY_FUNC_NAMES="$(
  {
    list_sg_names python 'def $NAME($$$): $$$' "$PY_GLOB"
    list_sg_names python 'async def $NAME($$$): $$$' "$PY_GLOB"
  } | sort -u
)"
PY_CLASS_NAMES="$(
  {
    list_sg_names python 'class $NAME: $$$' "$PY_GLOB"
    list_sg_names python 'class $NAME($BASE): $$$' "$PY_GLOB"
  } | sort -u
)"
PY_VAR_NAMES="$(list_sg_names python '$NAME = $VALUE' "$PY_GLOB" | sort -u)"
TSJS_FUNCTION_USAGE_NAMES="$(
  {
    printf "%s\n" "$TSJS_FUNC_NAMES"
    printf "%s\n" "$TSJS_ARROW_NAMES"
  } | sed '/^$/d' | sort -u
)"
TSJS_VARIABLE_USAGE_NAMES="$(
  comm -23 \
    <(printf "%s\n" "$TSJS_VAR_NAMES" | sed '/^$/d' | sort -u) \
    <(printf "%s\n" "$TSJS_ARROW_NAMES" | sed '/^$/d' | sort -u)
)"
PY_FUNCTION_USAGE_NAMES="$PY_FUNC_NAMES"
PY_VARIABLE_USAGE_NAMES="$PY_VAR_NAMES"
TSJS_IDENTIFIER_OCCURRENCES="$(build_ts_js_identifier_occurrence_table)"
PY_IDENTIFIER_OCCURRENCES="$(build_identifier_occurrence_table "$PY_GLOB")"
TSJS_FUNCTION_USAGE_COUNTS="$(build_usage_counts "$TSJS_FUNCTION_USAGE_NAMES" "$TSJS_IDENTIFIER_OCCURRENCES")"
TSJS_VARIABLE_USAGE_COUNTS="$(build_usage_counts "$TSJS_VARIABLE_USAGE_NAMES" "$TSJS_IDENTIFIER_OCCURRENCES")"
PY_FUNCTION_USAGE_COUNTS="$(build_usage_counts "$PY_FUNCTION_USAGE_NAMES" "$PY_IDENTIFIER_OCCURRENCES")"
PY_VARIABLE_USAGE_COUNTS="$(build_usage_counts "$PY_VARIABLE_USAGE_NAMES" "$PY_IDENTIFIER_OCCURRENCES")"

echo "== Symbol Inventory (AST) =="
print_name_block "ts/js function names" "$TSJS_FUNC_NAMES"
print_name_block "ts/js arrow-function variable names" "$TSJS_ARROW_NAMES"
print_name_block "ts/js class names" "$TSJS_CLASS_NAMES"
print_name_block "ts/js variable names (const/let/var)" "$TSJS_VAR_NAMES"
print_name_block "python function names" "$PY_FUNC_NAMES"
print_name_block "python class names" "$PY_CLASS_NAMES"
print_name_block "python variable names (= assignments)" "$PY_VAR_NAMES"
echo

echo "== Usage Counts (rg-only heuristic) =="
echo "Note: counts are direct identifier-token matches from rg. If a symbol only appears once, it is often declaration-only and worth reviewing for garbage/dead code."
print_usage_distribution_block "ts/js functions" "$TSJS_FUNCTION_USAGE_COUNTS"
print_usage_distribution_block "ts/js variables" "$TSJS_VARIABLE_USAGE_COUNTS"
print_usage_distribution_block "python functions" "$PY_FUNCTION_USAGE_COUNTS"
print_usage_distribution_block "python variables" "$PY_VARIABLE_USAGE_COUNTS"
echo
print_usage_count_block "Lowest-usage ts/js functions" "$TSJS_FUNCTION_USAGE_COUNTS"
print_usage_count_block "Lowest-usage ts/js variables" "$TSJS_VARIABLE_USAGE_COUNTS"
print_usage_count_block "Lowest-usage python functions" "$PY_FUNCTION_USAGE_COUNTS"
print_usage_count_block "Lowest-usage python variables" "$PY_VARIABLE_USAGE_COUNTS"
echo
print_usage_count_block "Highest-usage ts/js functions" "$TSJS_FUNCTION_USAGE_COUNTS" desc 8
print_usage_count_block "Highest-usage ts/js variables" "$TSJS_VARIABLE_USAGE_COUNTS" desc 8
print_usage_count_block "Highest-usage python functions" "$PY_FUNCTION_USAGE_COUNTS" desc 8
print_usage_count_block "Highest-usage python variables" "$PY_VARIABLE_USAGE_COUNTS" desc 8
echo

# Syntax relationships
TSJS_IMPORT_TARGETS="$(
  {
    list_ts_js_values 'import $X from "$MOD"'
    list_ts_js_values 'import "$MOD"'
  } | sed '/^$/d'
)"
TSJS_REEXPORT_TARGETS="$(
  {
    list_ts_js_values 'export { $$$ } from "$MOD"'
    list_ts_js_values 'export * from "$MOD"'
  } | sed '/^$/d'
)"
PY_IMPORT_TARGETS="$(
  {
    list_sg_values python 'from $MOD import $$$' "$PY_GLOB" MOD
    list_sg_values python 'import $MOD' "$PY_GLOB" MOD
  } | sed '/^$/d'
)"
TSJS_EXTENDS_BASES="$(list_ts_js_values 'class $NAME extends $BASE { $$$ }' BASE | sed '/^$/d')"
PY_BASES="$(list_sg_values python 'class $NAME($BASE): $$$' "$PY_GLOB" BASE | sed '/^$/d')"

TSJS_LOCAL_IMPORT_TARGETS="$(filter_values "$TSJS_IMPORT_TARGETS" "$LOCAL_TSJS_RE")"
TSJS_EXTERNAL_IMPORT_TARGETS="$(filter_values "$TSJS_IMPORT_TARGETS" "$LOCAL_TSJS_RE" exclude)"
TSJS_LOCAL_REEXPORT_TARGETS="$(filter_values "$TSJS_REEXPORT_TARGETS" "$LOCAL_TSJS_RE")"
TSJS_EXTERNAL_REEXPORT_TARGETS="$(filter_values "$TSJS_REEXPORT_TARGETS" "$LOCAL_TSJS_RE" exclude)"
PY_LOCAL_IMPORT_TARGETS="$(filter_values "$PY_IMPORT_TARGETS" "$LOCAL_PY_RE")"
PY_EXTERNAL_IMPORT_TARGETS="$(filter_values "$PY_IMPORT_TARGETS" "$LOCAL_PY_RE" exclude)"

AGENTS_COUNT="$(rg --files "$MODULE_PATH" | rg '/AGENTS\.md$' | wc -l | tr -d ' ' || true)"
AGENTS_COUNT="\${AGENTS_COUNT:-0}"
TSJS_IMPORTS="$(count_nonempty_lines "$TSJS_IMPORT_TARGETS")"
TSJS_REL_IMPORTS="$(count_nonempty_lines "$TSJS_LOCAL_IMPORT_TARGETS")"
TSJS_REEXPORTS="$(count_nonempty_lines "$TSJS_REEXPORT_TARGETS")"
TSJS_REL_REEXPORTS="$(count_nonempty_lines "$TSJS_LOCAL_REEXPORT_TARGETS")"
PY_IMPORTS="$(count_nonempty_lines "$PY_IMPORT_TARGETS")"
PY_REL_IMPORTS="$(count_nonempty_lines "$PY_LOCAL_IMPORT_TARGETS")"
TSJS_EXTENDS="$(count_nonempty_lines "$TSJS_EXTENDS_BASES")"
PY_EXTENDS="$(count_nonempty_lines "$PY_BASES")"
ENTRYPOINT_CANDIDATES="$(rg --files "$MODULE_PATH" | rg '/(index|main|app)\.(ts|tsx|js|jsx|py)$' | wc -l | tr -d ' ' || true)"

echo "== Syntax Relationships =="
echo "module AGENTS files:        $AGENTS_COUNT"
echo "ts/js import edges:         $TSJS_IMPORTS"
echo "ts/js relative imports:     $TSJS_REL_IMPORTS"
echo "ts/js re-export edges:      $TSJS_REEXPORTS"
echo "ts/js local re-exports:     $TSJS_REL_REEXPORTS"
echo "ts/js extends edges:        $TSJS_EXTENDS"
echo "python import edges:        $PY_IMPORTS"
echo "python relative imports:    $PY_REL_IMPORTS"
echo "python inheritance edges:   $PY_EXTENDS"
echo "entrypoint-like files:      $ENTRYPOINT_CANDIDATES"
echo

print_relation_block "Top local import targets (TS/JS, AST)" "$TSJS_LOCAL_IMPORT_TARGETS"
echo
print_relation_block "Top external import targets (TS/JS, AST)" "$TSJS_EXTERNAL_IMPORT_TARGETS"
echo
print_relation_block "Top local re-export targets (TS/JS, AST)" "$TSJS_LOCAL_REEXPORT_TARGETS"
echo
print_relation_block "Top external re-export targets (TS/JS, AST)" "$TSJS_EXTERNAL_REEXPORT_TARGETS"
echo
print_relation_block "Top local import targets (Python, AST)" "$PY_LOCAL_IMPORT_TARGETS"
echo
print_relation_block "Top external import targets (Python, AST)" "$PY_EXTERNAL_IMPORT_TARGETS"
echo
print_relation_block "Top base classes (TS/JS extends)" "$TSJS_EXTENDS_BASES"
echo
print_relation_block "Top base classes (Python inheritance)" "$PY_BASES"
echo

TSJS_ENV_NAMES="$(list_ts_js_env_names)"
PY_ENV_NAMES="$(list_python_env_names)"
ENV_FILE_NAMES="$(list_env_file_names)"
ALL_ENV_NAMES="$(
  {
    printf "%s\n" "$TSJS_ENV_NAMES"
    printf "%s\n" "$PY_ENV_NAMES"
    printf "%s\n" "$ENV_FILE_NAMES"
  } | sed '/^$/d' | sort -u
)"

echo "== Environment Names =="
print_name_block "ts/js env names (code references only)" "$TSJS_ENV_NAMES"
print_name_block "python env names (code references only)" "$PY_ENV_NAMES"
print_name_block ".env-style file keys (names only)" "$ENV_FILE_NAMES"
print_name_block "combined env names" "$ALL_ENV_NAMES"
echo

echo "Recommendation: start codemap conclusions from syntax relationships, then layer purpose, runtime boundaries, env boundaries, and call-flow interpretation on top."
`.replaceAll("\\$", "$");

const TOOL_NAME = "codemap";
const TOOL_LABEL = "Codemap";
const TOOL_TIMEOUT_MS = 120_000;
const TEMP_OUTPUT_PREFIX = "pi-codemap-";
const TEMP_OUTPUT_FILE = "output.txt";

const CodemapParams = Type.Object({
    path: Type.Optional(
        Type.String({
            description:
                "Directory to inspect, relative to the current working directory. Leading @ is allowed.",
        }),
    ),
});

interface CodemapDetails {
    path: string;
    truncated?: boolean;
    fullOutputPath?: string;
}

function normalizeModulePath(input?: string): string {
    if (!input) {
        return ".";
    }

    const normalized = input.replace(/^@/, "").trim();
    return normalized || ".";
}

function appendTruncationNotice(
    text: string,
    truncation: TruncationResult,
    outputPath: string,
): string {
    const hiddenLines = truncation.totalLines - truncation.outputLines;
    const hiddenBytes = truncation.totalBytes - truncation.outputBytes;

    let result = text;
    result += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` ${hiddenLines} lines (${formatSize(hiddenBytes)}) omitted.`;
    result += ` Full output saved to: ${outputPath}]`;
    return result;
}

async function saveFullOutput(output: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(tmpdir(), TEMP_OUTPUT_PREFIX));
    const tempFile = path.join(tempDir, TEMP_OUTPUT_FILE);
    await withFileMutationQueue(tempFile, async () => {
        await writeFile(tempFile, output, "utf8");
    });
    return tempFile;
}

async function runCodemapScript(
    pi: ExtensionAPI,
    cwd: string,
    targetPath: string,
    signal?: AbortSignal,
) {
    return pi.exec(
        "bash",
        ["-c", MODULE_STATS_SCRIPT, "codemap.sh", targetPath],
        {
            cwd,
            signal,
            timeout: TOOL_TIMEOUT_MS,
        },
    );
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: TOOL_NAME,
        label: TOOL_LABEL,
        description: `Generate deterministic codemap stats for a module or repo path, with a syntax-relationship-first view of imports, re-exports, inheritance, entrypoint-like files, symbol inventory, rg-only usage-count heuristics, and env-name discovery without values. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, the full report is saved to a temp file.`,
        promptSnippet:
            "Generate deterministic codemap stats with syntax relationships first, rg-only usage heuristics, and env-name discovery.",
        promptGuidelines: [
            "Use codemap before writing architecture conclusions when deterministic syntax relationships, symbol inventory, rg-only usage heuristics, or entrypoint evidence would help.",
            "Start from import targets, re-export hubs, inheritance edges, and entrypoint-like files before inferring higher-level architecture.",
            "Prefer a focused module path over the repo root when the user scopes the request to one area.",
        ],
        parameters: CodemapParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const targetPath = normalizeModulePath(params.path);

            onUpdate?.({
                content: [
                    {
                        type: "text",
                        text: `Collecting codemap stats for ${targetPath}...`,
                    },
                ],
                details: { path: targetPath },
            });

            const result = await runCodemapScript(
                pi,
                ctx.cwd,
                targetPath,
                signal,
            );

            if (result.code !== 0) {
                const message =
                    result.stderr.trim() ||
                    result.stdout.trim() ||
                    `${TOOL_NAME} failed with code ${result.code}`;
                throw new Error(message);
            }

            const output = result.stdout.trim() || "No output.";
            const truncation = truncateHead(output, {
                maxLines: DEFAULT_MAX_LINES,
                maxBytes: DEFAULT_MAX_BYTES,
            });
            const details: CodemapDetails = { path: targetPath };

            if (!truncation.truncated) {
                return {
                    content: [{ type: "text", text: truncation.content }],
                    details,
                };
            }

            const fullOutputPath = await saveFullOutput(output);
            details.truncated = true;
            details.fullOutputPath = fullOutputPath;

            return {
                content: [
                    {
                        type: "text",
                        text: appendTruncationNotice(
                            truncation.content,
                            truncation,
                            fullOutputPath,
                        ),
                    },
                ],
                details,
            };
        },
    });
}
