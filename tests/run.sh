#!/usr/bin/env bash
# The v1 suite tests deterministic translation, snapshot isolation and artifact integrity.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node --test tests/*.test.ts
