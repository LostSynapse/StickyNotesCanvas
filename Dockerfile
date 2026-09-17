# syntax=docker/dockerfile:1.7
#
# Self-hosted web build: server/server.js serving the app and a per-user
# notes API. Nothing is compiled and there are no npm dependencies, so a
# multi-arch image is the same files copied onto each platform's Node base.
#
#   docker buildx build --platform linux/amd64,linux/arm64 -t sticky-notes-canvas .
#
# Runs as UID 65532 with notes under /data. See deploy/README.md.

# Distroless has no shell, so /data is made — owned by the runtime user —
# here. Runs on the build host for every target platform: no emulation.
FROM --platform=$BUILDPLATFORM busybox:1.37 AS data
RUN mkdir -p /out/data && chown 65532:65532 /out/data

FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /app
# The renderer files — keep in step with package.json build.files and
# STATIC_FILES / STATIC_DIRS in server/server.js.
COPY index.html app.jsx components.jsx hooks.jsx utils.jsx ./
COPY vendor/ vendor/
COPY assets/ assets/
COPY server/server.js server/web-sync.js server/
COPY --from=data /out/ /

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]

# The base image's entrypoint is node itself.
CMD ["server/server.js"]
