# @omni-work/terminal-core

Terminal sizing, control-key, and input helpers shared by OmniWork clients.

## Install

```sh
npm install @omni-work/terminal-core
```

## Usage

```ts
import {
  clampTerminalSize,
  createControlInput,
  createTextInput,
} from "@omni-work/terminal-core";

const size = clampTerminalSize({ cols: 120, rows: 40 });
const text = createTextInput("hello");
const interrupt = createControlInput("ctrlC");
```

This package is ESM-only and requires Node.js 20.19 or newer when used in Node.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
