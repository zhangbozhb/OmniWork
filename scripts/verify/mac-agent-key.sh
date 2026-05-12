#!/usr/bin/env sh
set -eu

node --experimental-strip-types mac/agent/tests/auth-key.test.ts
