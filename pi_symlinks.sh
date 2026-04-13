#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_ROOT="${HOME}/.pi/agent"

find_pi_repo_root() {
  local candidate

  for candidate in "${SCRIPT_DIR}" "${SCRIPT_DIR}/.." "${SCRIPT_DIR}/../.."; do
    candidate="$(cd "${candidate}" && pwd)"
    if [ -d "${candidate}/extensions" ] && [ -d "${candidate}/subagent" ] && [ -f "${candidate}/AGENTS.md" ]; then
      echo "${candidate}"
      return
    fi
  done

  echo "Could not determine Pi repo root from script location: ${SCRIPT_DIR}" >&2
  exit 1
}

PI_REPO_ROOT="$(find_pi_repo_root)"

link_path() {
  local source="$1"
  local target="$2"

  if [ ! -e "${source}" ]; then
    echo "Missing source: ${source}" >&2
    exit 1
  fi

  if [ -L "${target}" ] && [ "$(readlink "${target}")" = "${source}" ]; then
    echo "Already linked: ${target} -> ${source}"
    return
  fi

  if [ -e "${target}" ] || [ -L "${target}" ]; then
    rm -rf "${target}"
    echo "Removed existing target: ${target}"
  fi

  ln -s "${source}" "${target}"
  echo "Linked: ${target} -> ${source}"
}

mkdir -p "${PI_ROOT}"

echo "Pi repo root: ${PI_REPO_ROOT}"
echo "Pi runtime root: ${PI_ROOT}"
echo
echo "Linking Pi repo-managed development paths..."

link_path "${PI_REPO_ROOT}/extensions" "${PI_ROOT}/extensions"
link_path "${PI_REPO_ROOT}/subagent/agents" "${PI_ROOT}/agents"
link_path "${PI_REPO_ROOT}/subagent/prompts" "${PI_ROOT}/prompts"
link_path "${PI_REPO_ROOT}/AGENTS.md" "${PI_ROOT}/AGENTS.md"
link_path "${PI_REPO_ROOT}/biome.json" "${PI_ROOT}/biome.json"

echo
echo "Left local in ${PI_ROOT}:"
echo "  auth.json"
echo "  sessions/"
echo "  skills/"
echo "  settings.json"
echo "  models.json"
echo
echo "Git continues to manage the real content in:"
echo "  ${PI_REPO_ROOT}/extensions"
echo "  ${PI_REPO_ROOT}/subagent/agents"
echo "  ${PI_REPO_ROOT}/subagent/prompts"
echo "  ${PI_REPO_ROOT}/AGENTS.md"
echo "  ${PI_REPO_ROOT}/biome.json"
