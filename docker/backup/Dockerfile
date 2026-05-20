# Velvet Backup Runner Image
# Contains all tools needed to run every backup script.
# Build: docker build -t velvet-backup:latest -f docker/backup/Dockerfile .

FROM ubuntu:24.04

ARG WALG_VERSION=3.0.3
ARG PG_VERSION=18

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    gnupg2 \
    lsb-release \
    openssl \
    jq \
    redis-tools \
    unzip \
    gzip \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ── PostgreSQL client ─────────────────────────────────────────────────────────
RUN curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] \
       https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-client-${PG_VERSION} \
    && rm -rf /var/lib/apt/lists/*

# ── AWS CLI v2 ────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# ── WAL-G ─────────────────────────────────────────────────────────────────────
RUN wget -qO /usr/local/bin/wal-g \
    "https://github.com/wal-g/wal-g/releases/download/v${WALG_VERSION}/wal-g-pg-ubuntu-24.04-amd64" \
    && chmod +x /usr/local/bin/wal-g

# ── Docker CLI (for restore-test.sh ephemeral container) ─────────────────────
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] \
       https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# ── Scripts ───────────────────────────────────────────────────────────────────
COPY scripts/backup/ /scripts/
RUN chmod +x /scripts/*.sh

WORKDIR /
