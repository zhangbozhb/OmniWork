#!/usr/bin/env sh
set -eu

node --experimental-strip-types desktop/agent/tests/auth-key.test.ts
