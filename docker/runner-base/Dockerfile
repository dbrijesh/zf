# Zerovity runner base image: the sandbox every agent run executes in.
# Non-root, git + node + python and the three harness CLIs. Network egress is enforced outside (runner allowlist).
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG COPILOT_VERSION=latest
# Cursor CLI: installed with its official installer (binary name: agent). Pin by building from a fixed install script if you need reproducibility.
ARG CURSOR_INSTALL_URL=https://cursor.com/install
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep python3 python3-pip build-essential jq openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
# The CLIs change often: pin the versions you validated (see packages/harness/*/VERSION_NOTES.md).
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} @github/copilot@${COPILOT_VERSION}
RUN useradd --create-home --uid 1000 --shell /bin/bash zf && mkdir -p /workspace && chown zf:zf /workspace
# The sandbox mounts a per-work-item folder over /home/zf, so install Cursor system-wide (outside the home folder).
RUN mkdir -p /opt/cursor && HOME=/opt/cursor bash -c 'curl -fsSL ${CURSOR_INSTALL_URL} | bash' || echo 'cursor CLI not installed (optional)'; \
    for b in agent cursor-agent; do [ -x /opt/cursor/.local/bin/$b ] && ln -sf /opt/cursor/.local/bin/$b /usr/local/bin/$b; done; chmod -R a+rX /opt/cursor || true
USER zf
ENV HOME=/home/zf GIT_TERMINAL_PROMPT=0 CI=1
WORKDIR /workspace/work
CMD ["sleep", "infinity"]