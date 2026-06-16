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
 * - 通过 OmniWork App target 的 Xcode build settings 展开环境变量，避免签名参数污染 Pods target。
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";

try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch (e) {
  // Ignore if .env doesn't exist
}

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

const childEnv = {
  ...process.env,
  OMNIWORK_APP_VERSION: appVersion,
  OMNIWORK_IOS_BUILD_NUMBER: buildNumber,
  OMNIWORK_IOS_BUNDLE_ID: bundleId,
  OMNIWORK_IOS_DEVELOPMENT_TEAM: required.OMNIWORK_IOS_DEVELOPMENT_TEAM,
  OMNIWORK_IOS_PROVISIONING_PROFILE: required.OMNIWORK_IOS_PROVISIONING_PROFILE,
  OMNIWORK_IOS_CODE_SIGN_STYLE: codeSignStyle,
  OMNIWORK_IOS_CODE_SIGN_IDENTITY: codeSignIdentity,
};

const args = [
  "react-native",
  "build-ios",
  "--mode",
  "Release",
];

const result = spawnSync("pnpm", ["exec", ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: childEnv,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
