#!/bin/sh
set -eu
ROOT="${SKILL_GATEWAY_ROOT:-$(CDPATH= cd -- "$(dirname "$0")/../../../.." && pwd)}"
exec "${NODE_BIN:-node}" "$ROOT/dist/http-mcp.js"
