import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { generateIdentityKeyPair } from "@omni-work/protocol-ts";
import * as pairingConfig from "../src/features/auth/pairingConfig.ts";
import { createPairingShareLink } from "../src/features/auth/pairingShare.ts";
import type { PairingConfig } from "../src/features/auth/types.ts";
import type { PairingScreenProps } from "../src/screens/pairing/PairingScreen";

type Element = {
  type: string;
  props: Record<string, any>;
};

// Exercise screen callbacks with native widgets stubbed; no camera or DOM needed.
function mountScreen(initialPairing?: PairingConfig) {
  const state: unknown[] = [];
  let cursor = 0;
  const submitted: PairingConfig[] = [];
  const source = readFileSync(
    new URL("../src/screens/pairing/PairingScreen.tsx", import.meta.url),
    "utf8",
  );
  const exports: { PairingScreen?: (props: PairingScreenProps) => Element } = {};
  const jsx = (type: string, props: Element["props"]) => ({ type, props });
  const mocks: Record<string, unknown> = {
    react: {
      useState(value: unknown) {
        const index = cursor++;
        if (!(index in state)) state[index] = value;
        return [state[index], (next: unknown) => { state[index] = next; }];
      },
      useEffect() {},
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      Alert: { alert() {} },
      Platform: { OS: "web", select: (values: Record<string, unknown>) => values.default },
      StyleSheet: { create: (styles: unknown) => styles },
      Text: "Text",
      TextInput: "TextInput",
      View: "View",
    },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "../../app/appConfig": {
      appConfig: {
        defaultRelayUrl: "ws://127.0.0.1:8081/relay/ws/mobile",
      },
    },
    "../../features/auth/pairingConfig": pairingConfig,
    "../../ui/components": { Button: "Button", Card: "Card" },
    "../../ui/KeyboardAwareScrollView": { KeyboardAwareScrollView: "ScrollView" },
    "../../ui/theme": { colors: {}, radii: {}, spacing: {}, typography: {} },
    "./PairingQrScannerModal": {
      PAIRING_SCANNER_SUPPORTED: true,
      PairingQrScannerModal: "Scanner",
    },
  };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText, {
    exports,
    require(name: string) {
      assert.ok(name in mocks, `Unexpected dependency: ${name}`);
      return mocks[name];
    },
  });

  function elements(node: Element): Element[] {
    return [node, ...[node.props.children].flat(Infinity)
      .filter((child): child is Element => Boolean(child?.props))
      .flatMap(elements)];
  }
  function render() {
    cursor = 0;
    return elements(exports.PairingScreen!({
      initialPairing,
      onPair: (pairing) => { submitted.push(pairing); },
    }));
  }
  function find(predicate: (element: Element) => boolean): Element {
    const element = render().find(predicate);
    assert.ok(element);
    return element;
  }
  return {
    submitted,
    input: (placeholder: string) => find(
      (node) => node.type === "TextInput" && node.props.placeholder === placeholder,
    ).props,
    token: () => find((node) => node.props.secureTextEntry === true).props,
    button: (label: string) => find(
      (node) => node.type === "Button" && node.props.children === label,
    ).props,
    scan: (pairing: PairingConfig) => find((node) => node.type === "Scanner")
      .props.onScanned(pairing),
  };
}

test("PairingScreen uses the configured Relay URL for a new target", () => {
  const screen = mountScreen();
  assert.equal(
    screen.input("wss://your-domain.example/relay/ws/mobile").value,
    "ws://127.0.0.1:8081/relay/ws/mobile",
  );
});

test("PairingScreen sends the private input for manual, link and scanned targets", async () => {
  const target = pairingConfig.createPairingConfig({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: generateIdentityKeyPair("agent").id,
  })!;
  for (const mode of ["details", "link", "scan"]) {
    const screen = mountScreen();
    assert.equal(screen.token().secureTextEntry, true);
    assert.equal(screen.token().autoComplete, "off");
    if (mode === "details") {
      screen.input("wss://your-domain.example/relay/ws/mobile").onChangeText(target.relayUrl);
      screen.input("DEV1-...").onChangeText(target.deviceId);
    } else if (mode === "link") {
      screen.button("pairing.modes.link").onPress();
      screen.input("omniwork://pair?...").onChangeText(createPairingShareLink(target));
    } else {
      await screen.scan({ ...target, relaySessionToken: "ignored-scanned-token" });
      assert.equal(screen.submitted.length, 0);
    }
    screen.token().onChangeText(" \n private-session \t ");
    await screen.button("pairing.actions.save").onPress();
    assert.equal(screen.submitted.length, 1);
    assert.equal(screen.submitted[0]?.relaySessionToken, "private-session");
    assert.equal(screen.submitted[0]?.deviceId, target.deviceId);
  }
});

test("PairingScreen editing clears tokens on origin changes and permits explicit removal", async () => {
  const target = pairingConfig.createPairingConfig({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: generateIdentityKeyPair("agent").id,
    relaySessionToken: "saved-session",
  })!;
  const screen = mountScreen(target);
  assert.equal(screen.token().value, "saved-session");
  screen.input("wss://your-domain.example/relay/ws/mobile")
    .onChangeText("wss://relay.example/another-path");
  assert.equal(screen.token().value, "saved-session");
  screen.input("wss://your-domain.example/relay/ws/mobile")
    .onChangeText("wss://other.example/relay/ws/mobile");
  assert.equal(screen.token().value, "");
  await screen.button("pairing.actions.save").onPress();
  assert.equal(screen.submitted[0]?.relaySessionToken, undefined);
  assert.equal(screen.submitted[0]?.relayUrl, "wss://other.example/relay/ws/mobile");
  screen.token().onChangeText("replacement");
  screen.token().onChangeText("");
  await screen.button("pairing.actions.save").onPress();
  assert.equal(screen.submitted[1]?.relaySessionToken, undefined);
});

test("PairingScreen rejects invalid targets and accepts an empty optional token", async () => {
  const screen = mountScreen();
  await screen.button("pairing.actions.save").onPress();
  assert.equal(screen.submitted.length, 0);
  screen.button("pairing.modes.link").onPress();
  screen.input("omniwork://pair?...").onChangeText("invalid");
  await screen.button("pairing.actions.save").onPress();
  assert.equal(screen.submitted.length, 0);
  await screen.scan(pairingConfig.createPairingConfig({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: generateIdentityKeyPair("agent").id,
  })!);
  await screen.button("pairing.actions.save").onPress();
  assert.equal(screen.submitted.length, 1);
  assert.equal(screen.submitted[0]?.relaySessionToken, undefined);
});

test("PairingScreen never carries a token across Relay origins through links or scans", async () => {
  const target = pairingConfig.createPairingConfig({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: generateIdentityKeyPair("agent").id,
  })!;
  const other = { ...target, relayUrl: "wss://other.example/relay/ws/mobile" };
  for (const mode of ["scan", "link", "link-replace", "details-return"]) {
    const screen = mountScreen();
    screen.input("wss://your-domain.example/relay/ws/mobile").onChangeText(target.relayUrl);
    screen.input("DEV1-...").onChangeText(target.deviceId);
    screen.token().onChangeText("private-relay-a");
    if (mode === "scan") {
      await screen.scan(other);
      assert.equal(screen.submitted.length, 0);
    } else {
      screen.button("pairing.modes.link").onPress();
      if (mode !== "link") {
        screen.input("omniwork://pair?...").onChangeText(createPairingShareLink(target));
        screen.token().onChangeText("private-relay-a");
      }
      screen.input("omniwork://pair?...").onChangeText(createPairingShareLink(other));
      if (mode === "details-return") {
        screen.token().onChangeText("private-relay-b");
        screen.button("pairing.modes.details").onPress();
      }
    }
    assert.equal(screen.token().value, "");
    await screen.button("pairing.actions.save").onPress();
    assert.equal(screen.submitted[0]?.relaySessionToken, undefined);
  }
  const sameOrigin = mountScreen();
  sameOrigin.input("wss://your-domain.example/relay/ws/mobile").onChangeText(target.relayUrl);
  sameOrigin.token().onChangeText("private-relay-a");
  await sameOrigin.scan(target);
  assert.equal(sameOrigin.token().value, "private-relay-a");
  await sameOrigin.button("pairing.actions.save").onPress();
  assert.equal(sameOrigin.submitted[0]?.relaySessionToken, "private-relay-a");
});
