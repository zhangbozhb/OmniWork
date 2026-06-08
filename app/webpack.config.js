const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const workspaceRoot = path.resolve(__dirname, "..");

const defaultRelayUrl =
  process.env.OMNIWORK_DEFAULT_RELAY_URL ??
  "wss://relay.company.example/relay/ws/mobile";
const appVersion = require("./package.json").version;

module.exports = {
  entry: path.resolve(__dirname, "index.web.tsx"),
  output: {
    path: path.resolve(__dirname, "dist/web"),
    filename: "static/js/[name].[contenthash:8].js",
    publicPath: "/",
    clean: true,
  },
  devtool: "source-map",
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
      "react-native$": "react-native-web",
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
        include: [
          path.resolve(__dirname),
          path.resolve(workspaceRoot, "packages"),
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
        omniworkDefaultRelayUrl: defaultRelayUrl,
        omniworkAppVersion: appVersion,
      },
    }),
    new webpack.DefinePlugin({
      "process.env.OMNIWORK_DEFAULT_RELAY_URL": JSON.stringify(defaultRelayUrl),
      "process.env.OMNIWORK_APP_VERSION": JSON.stringify(appVersion),
    }),
  ],
  devServer: {
    historyApiFallback: true,
    hot: true,
    port: 8081,
    static: {
      directory: path.resolve(__dirname, "web"),
    },
  },
};
