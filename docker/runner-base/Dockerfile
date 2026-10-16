# Zerovity runner base image: the sandbox every agent run executes in.
# Non-root, git + node + python and the three harness CLIs. Network egress is enforced outside (runner allowlist).
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG COPILOT_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep python3 python3-pip build-essential jq openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
# The CLIs change often: pin the versions you validated (see packages/harness/*/VERSION_NOTES.md).
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} @github/copilot@${COPILOT_VERSION}
RUN useradd --create-home --uid 1000 --shell /bin/bash zf && mkdir -p /workspace && chown zf:zf /workspace
USER zf
ENV HOME=/home/zf GIT_TERMINAL_PROMPT=0 CI=1
WORKDIR /workspace/work
CMD ["sleep", "infinity"]