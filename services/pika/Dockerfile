# Build context: services/pika
#   docker build -t pika services/pika
#   docker run -d -p 127.0.0.1:7171:7171 -v pika-data:/data pika

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# Release builds embed web/dist.
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --system --user-group --uid 10001 --home-dir /data --no-create-home pika \
	&& mkdir /data \
	&& chown pika:pika /data
COPY --from=build /src/target/release/pika /usr/local/bin/pika
ENV PIKA_BIND=0.0.0.0:7171 \
	PIKA_DATA_DIR=/data \
	PIKA_BASE_PATH=/
USER pika
WORKDIR /data
VOLUME /data
EXPOSE 7171
# Trims whitespace and slashes from PIKA_BASE_PATH like the server, so `pika`, `/pika/`, and `/` all work.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD b=$(printf %s "$PIKA_BASE_PATH" | sed 's|^[[:space:]/]*||; s|[[:space:]/]*$||') \
	&& curl -fsS "http://127.0.0.1:${PIKA_BIND##*:}${b:+/$b}/api/health" >/dev/null || exit 1
ENTRYPOINT ["pika"]
CMD ["serve"]
