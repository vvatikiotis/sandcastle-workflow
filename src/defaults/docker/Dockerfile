# This is Sandcastle's packaged default Dockerfile.
# A Consumer Repository may run `sandcastle-workflow eject-dockerfile` to copy it to
# `.sandcastle/Dockerfile`, then modify that complete project override. The override
# replaces this file; it does not extend it automatically. Rebuild the image after
# changing the override with `sandcastle-workflow build-image`.
#
# Required runtime capabilities for a custom override:
# - Node.js 22 or newer and the Consumer Repository's supported package manager
#   (npm 10 or pnpm 11). The default image provides Node.js and npm, then enables pnpm.
# - The `codex` executable, which the default image installs with npm.
# - Git, GitHub CLI (`gh`), and a POSIX shell for workflow and agent commands.
# - A non-root `agent` user whose UID/GID can be aligned with the build arguments,
#   `/home/agent/workspace` as the mounted project path, and a long-running entrypoint.
#
# Consumers may change the base image, installed operating-system packages, tool
# versions, and add other runtimes. Preserve the capabilities above, the AGENT_UID
# and AGENT_GID build arguments, the agent user's workspace access, and the entrypoint.

FROM node:22-bookworm

# Consumers may add or remove packages here, but Git, a POSIX shell, and the tools
# listed in the runtime contract above must remain available.
# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  fd-find \
  ripgrep \
  htop \
  btop \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI. Keep `gh` available to agents for GitHub issue operations.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build arguments for UID/GID alignment: sandcastle-workflow build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown. Keep these arguments
# if changing the user setup so mounted project files remain usable by the agent.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent). A custom image may install a
# pinned or otherwise different release, but `codex` must remain available to agents.
RUN npm install -g @openai/codex@latest

# Provide pnpm for pnpm Consumer Repositories. npm-based consumers use the npm
# supplied by Node.js; a custom image must provide the package manager it supports.
RUN corepack enable pnpm && corepack prepare pnpm@11.10 --activate

USER ${AGENT_UID}:${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
# Keep a long-running entrypoint so Sandcastle can start commands inside the container.
ENTRYPOINT ["sleep", "infinity"]
