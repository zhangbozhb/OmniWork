# @omni-work/surface-hook-post

Small CLI hook that forwards coding-agent event JSON from standard input to a
local OmniWork desktop agent.

This package is installed automatically with `@omni-work/desktop-agent`. For
standalone use:

```sh
npm install --global @omni-work/surface-hook-post
printf '{"event":"complete"}' | omniwork-hook-post
```

The command reads the local OmniWork session key by default. Its behavior can
be configured with:

- `OMNIWORK_AGENT_PROBE_URL`
- `OMNIWORK_AGENT_PROBE_TOKEN`
- `OMNIWORK_SESSION_KEY_PATH`
- `OMNIWORK_AGENT_PROBE_TIMEOUT_MS`

Missing credentials or an unavailable local agent are treated as a no-op so
the originating coding agent is not interrupted.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
