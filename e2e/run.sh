#!/usr/bin/env bash
# End to end in Docker, without a player: builds the integration image, starts
# the fake player (e2e/fake-bluos.mjs) on a Docker network, and runs
# e2e/in-image.mjs inside the image under the Gladys sandbox limits
# (read-only rootfs, 256 MB, 0.5 CPU, non-root, /data volume).
# Then checks that the entry point starts read-only (it stops at once
# without the Gladys environment variables, as expected).
set -euo pipefail
cd "$(dirname "$0")/.."
NET=bluos-e2e
docker build -q -t gladys-bluesound:e2e . >/dev/null
docker image ls gladys-bluesound:e2e --format 'image size: {{.Size}}'
docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f bluos-fake >/dev/null 2>&1 || true
docker run -d --rm --name bluos-fake --network "$NET" -v "$PWD:/repo:ro" -w /repo \
  node:24-alpine node e2e/fake-bluos.mjs >/dev/null
trap 'docker rm -f bluos-fake >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true' EXIT
sleep 1
docker volume create bluos-e2e-data >/dev/null
docker run --rm --read-only --memory 256m --cpus 0.5 --network "$NET" \
  -v bluos-e2e-data:/data -v "$PWD/e2e:/app/e2e:ro" gladys-bluesound:e2e \
  node /app/e2e/in-image.mjs
echo '--- the entry point, read-only, without Gladys (expected: the SDK asks for its env)'
docker run --rm --read-only --memory 256m --cpus 0.5 -v bluos-e2e-data:/data \
  gladys-bluesound:e2e 2>&1 | tail -3 || true
docker volume rm bluos-e2e-data >/dev/null
