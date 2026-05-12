module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ["module:@react-native/babel-preset"],
  };
};
