import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LANGUAGE } from "./language";
import en from "./resources/en.json";
import zhCN from "./resources/zh-CN.json";

void i18n.use(initReactI18next).init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
