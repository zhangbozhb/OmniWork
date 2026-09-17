require("react-native-get-random-values");

global.Buffer = require("buffer").Buffer;
require("./src/platform/nativeTextEncodingPolyfill")
  .installNativeTextEncodingPolyfill();

require("./src/main");
