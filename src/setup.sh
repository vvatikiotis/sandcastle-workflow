#!/bin/sh
set -eu

# Guided setup intentionally uses POSIX sh so it works when launched by Bash or Zsh.
command -v git >/dev/null 2>&1 || { printf '%s\n' 'Git is required.' >&2; exit 1; }
root=$(git rev-parse --show-toplevel) || { printf '%s\n' 'Run setup inside a Git worktree.' >&2; exit 1; }
cd "$root"

sandcastle_workflow_init() {
  script_dir=$(dirname "$0")
  sibling_cli=$script_dir/sandcastle-workflow
  if [ -x "$sibling_cli" ]; then
    "$sibling_cli" init
    return
  fi
  if [ -f "$script_dir/cli.js" ] && command -v node >/dev/null 2>&1; then
    node "$script_dir/cli.js" init
    return
  fi
  if command -v sandcastle-workflow >/dev/null 2>&1; then
    sandcastle-workflow init
    return
  fi

  printf '%s\n' 'sandcastle-workflow is not on PATH.' >&2
  exit 1
}

sandcastle_workflow_init

script_dir=$(dirname "$0")
consumer_guide=$script_dir/../@vvatikiotis/sandcastle-workflow/CONSUMER.md
if [ ! -f "$consumer_guide" ]; then
  consumer_guide=$script_dir/../CONSUMER.md
fi

extract_package_version() {
  awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$1" 2>/dev/null || true
}

extract_document_version() {
  grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' "$1" | head -n1 || true
}

consumer_destination=.sandcastle/CONSUMER.md
installed_version=$(extract_package_version "$script_dir/../package.json")
existing_consumer_version=$(extract_document_version "$consumer_destination")
if [ ! -e "$consumer_destination" ] && [ ! -L "$consumer_destination" ]; then
  cp "$consumer_guide" "$consumer_destination"
  printf 'Created %s\n' "$consumer_destination"
elif [ "$installed_version" != "" ] && [ "$existing_consumer_version" != "" ] && [ "$installed_version" != "$existing_consumer_version" ] && [ ! -L "$consumer_destination" ]; then
  cp "$consumer_guide" "$consumer_destination"
  printf 'Updated %s from %s to %s\n' "$consumer_destination" "$existing_consumer_version" "$installed_version"
else
  printf 'Preserving existing %s\n' "$consumer_destination"
fi

ask_yes_no() {
  prompt=$1
  default=$2
  printf '%s [%s] ' "$prompt" "$default"
  if ! read -r answer; then
    printf '%s\n' 'Input ended; setup aborted.' >&2
    exit 1
  fi
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    n|N|no|NO) return 1 ;;
    '') [ "$default" = y ] ;;
    *) printf '%s\n' 'Please answer y or n.' >&2; ask_yes_no "$prompt" "$default" ;;
  esac
}

should_create_configuration() {
  example=$1
  active=$2
  if [ -L "$active" ]; then
    printf 'Refusing symbolic configuration path %s\n' "$active" >&2
    exit 1
  fi
  if [ -e "$active" ]; then
    printf 'Preserving existing %s\n' "$active"
    return 1
  fi
  ask_yes_no "Create $active from $example?" y
}

create_configuration() {
  example=$1
  active=$2
  cp "$example" "$active"
  chmod 600 "$active"
  printf 'Created %s\n' "$active"
}

create_runner=n
if should_create_configuration .sandcastle/sandcastle.env.example .sandcastle/sandcastle.env; then
  create_runner=y
fi
create_agent_environment=n
if should_create_configuration .sandcastle/.env.example .sandcastle/.env; then
  create_agent_environment=y
fi

if [ "$create_runner" = y ]; then
  create_configuration .sandcastle/sandcastle.env.example .sandcastle/sandcastle.env
fi
if [ "$create_agent_environment" = y ]; then
  create_configuration .sandcastle/.env.example .sandcastle/.env
fi

printf '%s\n' '' 'Setup complete.'
printf '%s\n' 'Review .sandcastle/sandcastle.env and .sandcastle/.env, then run:'
if [ -f pnpm-lock.yaml ]; then
  printf '%s\n' '  pnpm sandcastle build-image' '  pnpm sandcastle:dry-run'
elif [ -f package-lock.json ]; then
  printf '%s\n' '  npm run sandcastle -- build-image' '  npm run sandcastle:dry-run'
else
  printf '%s\n' '  Use the Sandcastle project scripts documented in CONSUMER.md.'
fi
