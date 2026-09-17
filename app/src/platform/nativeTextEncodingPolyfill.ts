type TextEncodingGlobals = {
  TextEncoder?: typeof TextEncoder;
  TextDecoder?: typeof TextDecoder;
};

type TextEncodingModule = {
  TextEncoder: typeof TextEncoder;
  TextDecoder: typeof TextDecoder;
};

export function installNativeTextEncodingPolyfill(
  target: TextEncodingGlobals = globalThis,
  implementation?: TextEncodingModule,
): void {
  if (target.TextEncoder && target.TextDecoder) {
    return;
  }
  const polyfill =
    implementation ?? (require("text-encoding") as TextEncodingModule);
  target.TextEncoder ??= polyfill.TextEncoder;
  target.TextDecoder ??= polyfill.TextDecoder;
}
