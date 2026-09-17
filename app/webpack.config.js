const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const workspaceRoot = path.resolve(__dirname, "..");
const qrcodeSvgRoot = path.dirname(
  require.resolve("react-native-qrcode-svg/package.json"),
);
const reactNativeWebRoot = path.dirname(
  require.resolve("react-native-web/package.json"),
);

const webPublicPath = process.env.OMNIWORK_WEB_PUBLIC_PATH ?? "/";
const appVersion = require("./package.json").version;
const shouldGenerateSourceMap = process.env.GENERATE_SOURCEMAP !== "false";

module.exports = {
  entry: path.resolve(__dirname, "index.web.tsx"),
  output: {
    path: path.resolve(__dirname, "dist/web"),
    filename: "static/js/[name].[contenthash:8].js",
    publicPath: webPublicPath,
    clean: true,
  },
  devtool: shouldGenerateSourceMap ? "source-map" : false,
  resolve: {
    modules: [
      path.resolve(__dirname, "node_modules"),
      path.resolve(workspaceRoot, "node_modules"),
      "node_modules",
    ],
    extensions: [
      ".web.tsx",
      ".web.ts",
      ".tsx",
      ".ts",
      ".web.jsx",
      ".web.js",
      ".jsx",
      ".js",
      ".json",
    ],
    alias: {
      "@op-engineering/op-sqlite$": false,
      "@react-native/assets-registry/registry$": path.resolve(
        reactNativeWebRoot,
        "dist/modules/AssetRegistry/index.js",
      ),
      "react-native$": "react-native-web",
      "react-native-webrtc$": false,
    },
    symlinks: true,
  },
  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: {
          fullySpecified: false,
        },
      },
      {
        test: /\.[jt]sx?$/,
        // Workspace packages already publish browser-compatible ESM from dist.
        include: [
          path.resolve(__dirname),
          qrcodeSvgRoot,
        ],
        use: {
          loader: "babel-loader",
          options: {
            presets: ["module:@react-native/babel-preset"],
            cacheDirectory: true,
          },
        },
      },
      {
        test: /\.(png|jpe?g|gif|webp|svg)$/i,
        type: "asset/resource",
      },
      {
        test: /\.css$/i,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, "web/index.html"),
      templateParameters: {
        omniworkWebPublicPath: webPublicPath,
      },
    }),
    {
      apply(compiler) {
        compiler.hooks.thisCompilation.tap(
          "OmniWorkRuntimeConfig",
          (compilation) => {
            compilation.emitAsset(
              "omniwork-config.js",
              new webpack.sources.RawSource(
                runtimeConfigSource({
                  appVersion,
                  defaultRelayUrl: process.env.OMNIWORK_WEB_RELAY_URL,
                }),
              ),
            );
          },
        );
      },
    },
  ],
  devServer: {
    historyApiFallback: true,
    hot: true,
    port: 8081,
    proxy: [
      {
        context: ["/relay/ws"],
        target: "http://127.0.0.1:8787",
        ws: true,
      },
    ],
    static: {
      directory: path.resolve(__dirname, "web"),
    },
  },
};

function runtimeConfigSource(config) {
  const json = JSON.stringify(config, null, 2);
  return [
    "window.__OMNIWORK_APP_CONFIG__ = Object.assign(",
    "  {},",
    "  window.__OMNIWORK_APP_CONFIG__ || {},",
    `  ${json},`,
    ");",
    "",
  ].join("\n");
}
