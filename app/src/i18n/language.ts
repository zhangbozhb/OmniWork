export type AppLanguage = "en" | "zh-CN";

export const DEFAULT_LANGUAGE: AppLanguage = "en";
export const LANGUAGE_STORAGE_KEY = "omniwork.language";

export const APP_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: AppLanguage;
  label: string;
}> = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "en" || value === "zh-CN";
}

export function getAppLanguageLabel(language: AppLanguage): string {
  return (
    APP_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ??
    language
  );
}
