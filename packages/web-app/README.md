# @omni-work/web-app

Web-only publish package for OmniWork.

The React Native app remains in `app/` as `@omni-work/app`. This package only builds and packages the web output from `app/dist/web` into its own `dist/` directory for npm distribution.

```bash
pnpm --filter @omni-work/web-app build
```
