# syntax=docker/dockerfile:1.7
#
# server-e2e docker-run image.
#
# This image layers server-e2e defaults on top of the repository server dev
# image. Source code and node_modules are still provided by bind mounts from
# scripts/run-docker-e2e.sh, so host edits are picked up without rebuilding.
#
# The launcher intentionally does not pass -p/--publish to docker run. The
# server binds inside the container only, so this workflow can run alongside the
# docker-compose.yml server that publishes host port 7878.

ARG BASE_IMAGE=kimi-server:dev
FROM ${BASE_IMAGE}

ENV KIMI_CODE_HOME=/data/docker-e2e/kimi-code-home \
    KIMI_SERVER_URL=http://127.0.0.1:7878 \
    KIMI_SERVER_E2E_REPORT_DIR=/data/server-e2e-reports/docker/latest \
    TMPDIR=/data/docker-e2e/tmp \
    TERM=xterm-256color \
    TZ=Asia/Shanghai \
    npm_config_store_dir=/workspace/kimi-code/node_modules/.pnpm-store \
    npm_config_package_import_method=copy

WORKDIR /workspace/kimi-code/packages/server-e2e

CMD ["bash"]
