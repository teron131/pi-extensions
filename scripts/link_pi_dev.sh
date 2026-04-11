#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PI_ROOT="${HOME}/.pi/agent"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${PI_ROOT}/.backup-before-dev-links-${TIMESTAMP}"

backup_target() {
  local target="$1"

  mkdir -p "${BACKUP_ROOT}"
  mv "${target}" "${BACKUP_ROOT}/"
  echo "Backed up: ${target} -> ${BACKUP_ROOT}/"
}

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
    backup_target "${target}"
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
