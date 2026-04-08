/**
 * Codemap Extension
 *
 * Exposes the codemap module stats workflow as a custom Pi tool.
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
TSJS_GLOB='**/*.{ts,tsx,js,jsx}'
PY_GLOB='**/*.py'
IDENT_RE='^[A-Za-z_][A-Za-z0-9_]*$'

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

list_sg_names() {
  local lang="$1"
  local pattern="$2"
  local glob="$3"
  local key="\${4:-NAME}"
  sg run -p "$pattern" --lang "$lang" "$MODULE_PATH" --globs "$glob" --json=compact 2>/dev/null \
    | jq -r --arg k "$key" '.[]? | .metaVariables.single[$k].text // empty' 2>/dev/null \
    | sed '/^$/d' \
    | grep -E "$IDENT_RE" \
    | sort -u || true
}

list_ts_js_names() {
  local pattern="$1"
  {
    list_sg_names typescript "$pattern" "$TS_GLOB"
    list_sg_names javascript "$pattern" "$JS_GLOB"
  } | sort -u
}

print_name_block() {
  local title="$1"
  local values="$2"
  local limit="\${3:-40}"
  local count
  count="$(printf "%s\n" "$values" | sed '/^$/d' | wc -l | tr -d ' ')"
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

rg_count() {
  local glob="$1"
  local pattern="$2"
  rg -n --no-heading --glob "$glob" "$pattern" "$MODULE_PATH" 2>/dev/null \
    | wc -l | tr -d ' ' || true
}

rg_top_imports() {
  local pattern="$1"
  rg -o --no-filename --glob "$TSJS_GLOB" "$pattern" "$MODULE_PATH" 2>/dev/null \
    | sed -E 's/^from\s+["'\''](.*)["'\'']$/\1/' \
    | sort | uniq -c | sort -nr | head -10 || true
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
TSJS_CLASS="$(count_ts_js 'class $NAME { $$$ }')"

TSJS_EXPORTED_VARS="$(sum_counts \
  "$(count_ts_js 'export const $NAME = $VALUE')" \
  "$(count_ts_js 'export let $NAME = $VALUE')" \
  "$(count_ts_js 'export var $NAME = $VALUE')")"
TSJS_EXPORTED_FUNCS="$(count_ts_js 'export function $NAME($$$) { $$$ }')"
TSJS_EXPORTED_CLASSES="$(count_ts_js 'export class $NAME { $$$ }')"
TSJS_EXPORTED_DEFAULT="$(count_ts_js 'export default $X')"
TS_EXPORTED_TYPES="$(sum_counts \
  "$(count_sg typescript 'export type $NAME = $VALUE' "$TS_GLOB")" \
  "$(count_sg typescript 'export interface $NAME { $$$ }' "$TS_GLOB")")"
TSJS_EXPORTS_TOTAL="$(sum_counts \
  "$TSJS_EXPORTED_VARS" "$TSJS_EXPORTED_FUNCS" "$TSJS_EXPORTED_CLASSES" "$TSJS_EXPORTED_DEFAULT" "$TS_EXPORTED_TYPES")"

PY_FUNC="$(count_sg python 'def $NAME($$$): $$$' "$PY_GLOB")"
PY_ASYNC_FUNC="$(count_sg python 'async def $NAME($$$): $$$' "$PY_GLOB")"
PY_CLASS="$(count_sg python 'class $NAME: $$$' "$PY_GLOB")"
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
  } | sort -u
)"
TSJS_CLASS_NAMES="$(list_ts_js_names 'class $NAME { $$$ }')"
TSJS_VAR_NAMES="$(
  {
    list_ts_js_names 'const $NAME = $VALUE'
    list_ts_js_names 'let $NAME = $VALUE'
    list_ts_js_names 'var $NAME = $VALUE'
  } | sort -u
)"
PY_FUNC_NAMES="$(
  {
    list_sg_names python 'def $NAME($$$): $$$' "$PY_GLOB"
    list_sg_names python 'async def $NAME($$$): $$$' "$PY_GLOB"
  } | sort -u
)"
PY_CLASS_NAMES="$(list_sg_names python 'class $NAME: $$$' "$PY_GLOB" | sort -u)"
PY_VAR_NAMES="$(list_sg_names python '$NAME = $VALUE' "$PY_GLOB" | sort -u)"

echo "== Symbol Inventory (AST) =="
print_name_block "ts/js function names" "$TSJS_FUNC_NAMES"
print_name_block "ts/js arrow-function variable names" "$TSJS_ARROW_NAMES"
print_name_block "ts/js class names" "$TSJS_CLASS_NAMES"
print_name_block "ts/js variable names (const/let/var)" "$TSJS_VAR_NAMES"
print_name_block "python function names" "$PY_FUNC_NAMES"
print_name_block "python class names" "$PY_CLASS_NAMES"
print_name_block "python variable names (= assignments)" "$PY_VAR_NAMES"
echo

echo "== Syntax Relationships =="
AGENTS_COUNT="$(rg --files "$MODULE_PATH" | rg '/AGENTS\.md$' | wc -l | tr -d ' ' || true)"
AGENTS_COUNT="\${AGENTS_COUNT:-0}"
echo "module AGENTS files:        $AGENTS_COUNT"

TSJS_IMPORTS="$(rg_count "$TSJS_GLOB" '^\s*import\s+.*\s+from\s+["'\'']([^"'\'']+)["'\'']')"
TSJS_REL_IMPORTS="$(rg_count "$TSJS_GLOB" '^\s*import\s+.*\s+from\s+["'\''](\./|\.\./)[^"'\'']*["'\'']')"
TSJS_EXPORT_FROM="$(rg_count "$TSJS_GLOB" '^\s*export\s+.*\s+from\s+["'\'']([^"'\'']+)["'\'']')"
PY_IMPORTS="$(rg_count "$PY_GLOB" '^\s*(from\s+\S+\s+import\s+|import\s+)')"
ENTRYPOINT_CANDIDATES="$(rg --files "$MODULE_PATH" | rg '/(index|main|app)\.(ts|tsx|js|jsx|py)$' | wc -l | tr -d ' ' || true)"

echo "ts/js import edges:         \${TSJS_IMPORTS:-0}"
echo "ts/js relative imports:     \${TSJS_REL_IMPORTS:-0}"
echo "ts/js re-export edges:      \${TSJS_EXPORT_FROM:-0}"
echo "python import edges:        \${PY_IMPORTS:-0}"
echo "entrypoint-like files:      \${ENTRYPOINT_CANDIDATES:-0}"
echo

echo "Top local import targets (TS/JS):"
LOCAL_IMPORTS="$(rg_top_imports 'from\s+["'\''](\./|\.\./)[^"'\'']+["'\'']')"
if [[ -n "$LOCAL_IMPORTS" ]]; then
  echo "$LOCAL_IMPORTS"
else
  echo "  (none)"
fi
echo

echo "Top external import targets (TS/JS):"
EXT_IMPORTS="$(rg_top_imports 'from\s+["'\''][^./][^"'\'']*["'\'']')"
if [[ -n "$EXT_IMPORTS" ]]; then
  echo "$EXT_IMPORTS"
else
  echo "  (none)"
fi
echo

echo "AST export-from targets (TS/JS):"
EXPORT_FROM_AST="$(
  {
    sg run -p 'export { $$$ } from "$MOD"' --lang typescript "$MODULE_PATH" --globs "$TS_GLOB" --json=compact 2>/dev/null \
      | jq -r '.[]? | .metaVariables.single.MOD.text // empty' 2>/dev/null || true
    sg run -p 'export * from "$MOD"' --lang typescript "$MODULE_PATH" --globs "$TS_GLOB" --json=compact 2>/dev/null \
      | jq -r '.[]? | .metaVariables.single.MOD.text // empty' 2>/dev/null || true
    sg run -p 'export { $$$ } from "$MOD"' --lang javascript "$MODULE_PATH" --globs "$JS_GLOB" --json=compact 2>/dev/null \
      | jq -r '.[]? | .metaVariables.single.MOD.text // empty' 2>/dev/null || true
    sg run -p 'export * from "$MOD"' --lang javascript "$MODULE_PATH" --globs "$JS_GLOB" --json=compact 2>/dev/null \
      | jq -r '.[]? | .metaVariables.single.MOD.text // empty' 2>/dev/null || true
  } | sed '/^$/d' | sort | uniq -c | sort -nr | head -10
)"
if [[ -n "$EXPORT_FROM_AST" ]]; then
  echo "$EXPORT_FROM_AST"
else
  echo "  (none)"
fi
echo

echo "Recommendation: use this output as preflight evidence before writing codemap conclusions."
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
    signal: AbortSignal,
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
        description: `Generate deterministic filesystem, AST, symbol, and import/export stats for a module or repo path. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, the full report is saved to a temp file.`,
        promptSnippet:
            "Generate deterministic codemap stats for repo and module analysis.",
        promptGuidelines: [
            "Use codemap before writing architecture conclusions when deterministic scope, symbol, or relationship evidence would help.",
            "Prefer a focused module path over the repo root when the user scopes the request to one area.",
        ],
        parameters: CodemapParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const targetPath = normalizeModulePath(params.path);

            onUpdate?.({
                content: [
                    {
                        type: "text",
                        text: `Collecting module stats for ${targetPath}...`,
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
