import { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TransportPreference } from "@omniwork/protocol-ts";
import { isTransportPreference } from "@omniwork/protocol-ts";

import { appConfig } from "./appConfig";
import type { ConfirmOptions } from "../ui/confirm/ConfirmProvider";
import {
  getDefaultTerminalTextSize,
  isTerminalTextSize,
  type TerminalTextSize,
} from "../features/terminal/terminalLayout";
import i18n from "../i18n";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  isAppLanguage,
  type AppLanguage,
} from "../i18n/language";

const TRANSPORT_PREFERENCE_STORAGE_KEY = "omniwork.transportPreference";
const TERMINAL_TEXT_SIZE_STORAGE_KEY = "omniwork.terminal.textSize";

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

export function usePreferenceController(confirm: Confirm) {
  const [transportPreference, setTransportPreferenceState] =
    useState<TransportPreference>(appConfig.transportPreference);
  const [language, setLanguage] = useState<AppLanguage>(DEFAULT_LANGUAGE);
  const [terminalTextSize, setTerminalTextSizeState] =
    useState<TerminalTextSize>(() =>
      getDefaultTerminalTextSize(Dimensions.get("window")),
    );
  const terminalTextSizeLoadedRef = useRef(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(TRANSPORT_PREFERENCE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (isTransportPreference(raw)) {
          setTransportPreferenceState(raw);
        }
      })
      .catch(() => {
        // 持久化失败不影响功能；使用 appConfig 默认值。
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(TERMINAL_TEXT_SIZE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (isTerminalTextSize(raw)) {
          setTerminalTextSizeState(raw);
        }
      })
      .finally(() => {
        if (active) {
          terminalTextSizeLoadedRef.current = true;
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((raw) => {
        if (!active || !isAppLanguage(raw)) {
          return;
        }
        setLanguage(raw);
        void i18n.changeLanguage(raw);
      })
      .catch(() => {
        // 语言偏好读取失败不影响启动；使用默认英文。
      });
    return () => {
      active = false;
    };
  }, []);

  const handleChangeLanguage = useCallback((next: AppLanguage) => {
    setLanguage(next);
    void i18n.changeLanguage(next);
    AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, next).catch(() => {
      // 语言偏好持久化失败仅影响下次启动恢复。
    });
  }, []);

  const handleChangeTerminalTextSize = useCallback((next: TerminalTextSize) => {
    setTerminalTextSizeState(next);
    if (!terminalTextSizeLoadedRef.current) {
      return;
    }

    AsyncStorage.setItem(TERMINAL_TEXT_SIZE_STORAGE_KEY, next).catch(() => {
      // 字号偏好持久化失败不影响终端使用。
    });
  }, []);

  const handleChangeTransportPreference = useCallback(
    (next: TransportPreference) => {
      const persist = (value: TransportPreference) => {
        setTransportPreferenceState(value);
        AsyncStorage.setItem(TRANSPORT_PREFERENCE_STORAGE_KEY, value).catch(
          () => {
            // 非关键路径：偏好下次启动会回退到 appConfig 默认值。
          },
        );
      };
      if (next === "prefer_p2p") {
        confirm({
          title: "Switch to Direct only?",
          message:
            "The App will reconnect immediately. After a direct link is ready, no relay server will carry session payload data. The session may fail if a direct link cannot be established.",
          confirmText: "Switch",
          cancelText: "Cancel",
          tone: "primary",
          // 语义上是"切换连接路径"而非"删除"，覆盖默认的 trash 图标。
          confirmIcon: "plug",
        })
          .then((confirmed) => {
            if (confirmed) {
              persist(next);
            }
          })
          .catch(() => {
            // confirm Promise 不应 reject；保底吞掉。
          });
        return;
      }
      persist(next);
    },
    [confirm],
  );

  return {
    transportPreference,
    language,
    terminalTextSize,
    handleChangeLanguage,
    handleChangeTerminalTextSize,
    handleChangeTransportPreference,
  };
}
