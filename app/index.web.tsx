import { AppRegistry, type RootTag } from "react-native";
import { Buffer } from "buffer";

import App from "./src/app/App";

globalThis.Buffer = Buffer;

const root = document.getElementById("root");

if (!root) {
  throw new Error("OmniWork web root element was not found.");
}

AppRegistry.registerComponent("OmniWork", () => App);
AppRegistry.runApplication("OmniWork", {
  initialProps: {},
  // react-native-web accepts an HTMLElement; React Native's strict API exposes
  // only the native opaque RootTag at this shared import boundary.
  rootTag: root as unknown as RootTag,
});
