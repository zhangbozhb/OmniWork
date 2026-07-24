# @omni-work/surface-hook-record

CLI hook that records supported coding-agent events for later ingestion by the
OmniWork desktop agent.

This package is installed automatically with `@omni-work/desktop-agent`. For
standalone use:

```sh
npm install --global @omni-work/surface-hook-record
printf '{"hook_event_name":"SessionStart"}' | omniwork-hook-record
```

To install the managed Trae hook entries:

```sh
omniwork-hook-record install
```

The command writes local records only; it does not send them over the network.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
