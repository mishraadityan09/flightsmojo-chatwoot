#!/bin/bash
# Proves the email scripts on a throwaway Ubuntu (same release as the server)
# with a fake Chatwoot endpoint. Needs Docker Desktop running. ~2 minutes.
# Usage, from the repo root on a laptop:  bash scripts/email/test/run-in-docker.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
IMG=${IMG:-ubuntu:26.04}
docker run --rm \
  -v "$PWD/scripts/email:/work/email:ro" \
  -v "$PWD/scripts/email/test:/test:ro" \
  -v "$PWD/.env.example:/env.example:ro" \
  "$IMG" bash /test/inside-container.sh
