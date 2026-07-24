# @omni-work/web-app

Prebuilt static web application for OmniWork.

## Install

```sh
npm install @omni-work/web-app
```

Serve or copy the static assets from:

```text
node_modules/@omni-work/web-app/dist/
```

`dist/index.html` is the application entry point. Configure the Relay URL in
`dist/omniwork-config.js` or replace that file during deployment.

This package contains a prebuilt artifact and has no runtime API or build
scripts. To rebuild it from source, clone the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork) and run:

```sh
pnpm app:build:web
```
