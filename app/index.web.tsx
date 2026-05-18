import { AppRegistry } from "react-native";

import App from "./src/app/App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("OmniWork web root element was not found.");
}

AppRegistry.registerComponent("OmniWork", () => App);
AppRegistry.runApplication("OmniWork", {
  rootTag: root,
});
