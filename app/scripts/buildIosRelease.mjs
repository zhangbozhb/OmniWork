#!/usr/bin/env node
/**
 * iOS Release 构建：使用外部注入的签名身份。
 *
 * 必填环境变量：
 *   OMNIWORK_IOS_DEVELOPMENT_TEAM        Apple Developer Team ID（10 位）
 *   OMNIWORK_IOS_PROVISIONING_PROFILE     Provisioning profile 名称（与 Xcode "Provisioning Profile" 字段一致）
 *
 * 可选环境变量：
 *   OMNIWORK_APP_VERSION                  CFBundleShortVersionString（默认 0.1.0）
 *   OMNIWORK_IOS_BUILD_NUMBER             CFBundleVersion（默认 1）
 *   OMNIWORK_IOS_BUNDLE_ID                CFBundleIdentifier（默认 com.omniwork.mobile）
 *   OMNIWORK_IOS_CODE_SIGN_STYLE          Manual / Automatic（默认 Manual）
 *   OMNIWORK_IOS_CODE_SIGN_IDENTITY        e.g. "Apple Distribution" 或 "iPhone Distribution: Foo, Inc."
 *
 * 行为：
 * - 缺失必填变量时打印清晰错误并以 1 退出（避免静默产出无签名 IPA）；
 * - 显式拒绝 CODE_SIGNING_ALLOWED=NO，强制走真实签名链路；
 * - 透传给 react-native build-ios 的 --extra-params。
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

const env = process.env;

const required = {
  OMNIWORK_IOS_DEVELOPMENT_TEAM: env.OMNIWORK_IOS_DEVELOPMENT_TEAM,
  OMNIWORK_IOS_PROVISIONING_PROFILE: env.OMNIWORK_IOS_PROVISIONING_PROFILE,
};
const missing = Object.entries(required)
  .filter(([, value]) => !value || value.trim().length === 0)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(
    "[OmniWork] Missing iOS signing environment variables:\n  " +
      missing.join("\n  ") +
      "\nRun `pnpm app:build:ios:dev` if you only need an unsigned smoke build.",
  );
  process.exit(1);
}

const appVersion = env.OMNIWORK_APP_VERSION ?? "0.1.0";
const buildNumber = env.OMNIWORK_IOS_BUILD_NUMBER ?? "1";
const bundleId = env.OMNIWORK_IOS_BUNDLE_ID ?? "com.omniwork.mobile";
const codeSignStyle = env.OMNIWORK_IOS_CODE_SIGN_STYLE ?? "Manual";
const codeSignIdentity = env.OMNIWORK_IOS_CODE_SIGN_IDENTITY ?? "Apple Distribution";

const extraParams = [
  `MARKETING_VERSION=${appVersion}`,
  `CURRENT_PROJECT_VERSION=${buildNumber}`,
  `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
  `DEVELOPMENT_TEAM=${required.OMNIWORK_IOS_DEVELOPMENT_TEAM}`,
  `PROVISIONING_PROFILE_SPECIFIER=${required.OMNIWORK_IOS_PROVISIONING_PROFILE}`,
  `CODE_SIGN_STYLE=${codeSignStyle}`,
  `CODE_SIGN_IDENTITY=${codeSignIdentity}`,
  // 显式确保签名开启，避免被本地 xcconfig 关闭。
  "CODE_SIGNING_ALLOWED=YES",
  "CODE_SIGNING_REQUIRED=YES",
].join(" ");

const args = [
  "react-native",
  "build-ios",
  "--mode",
  "Release",
  "--extra-params",
  extraParams,
];

const result = spawnSync("pnpm", ["exec", ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
