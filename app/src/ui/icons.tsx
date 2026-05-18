import type { JSX } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

export type IconName =
  | "add"
  | "arrowLeft"
  | "bolt"
  | "check"
  | "chevronDown"
  | "chevronUp"
  | "close"
  | "device"
  | "edit"
  | "eye"
  | "eyeOff"
  | "keyboard"
  | "maximize"
  | "minimize"
  | "more"
  | "plug"
  | "provider"
  | "qr"
  | "refresh"
  | "save"
  | "send"
  | "settings"
  | "terminal"
  | "trash"
  | "xCircle";

export interface IconProps {
  color?: string;
  name: IconName;
  size?: number;
}

export function Icon({
  color = "currentColor",
  name,
  size = 20,
}: IconProps): JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {renderIcon(name, color)}
    </Svg>
  );
}

function renderIcon(name: IconName, color: string): JSX.Element {
  switch (name) {
    case "add":
      return (
        <>
          <Path d="M12 5v14" />
          <Path d="M5 12h14" />
        </>
      );
    case "arrowLeft":
      return (
        <>
          <Path d="M19 12H5" />
          <Path d="m12 19-7-7 7-7" />
        </>
      );
    case "bolt":
      return <Path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z" />;
    case "check":
      return <Path d="m5 12 4 4L19 6" />;
    case "chevronDown":
      return <Path d="m6 9 6 6 6-6" />;
    case "chevronUp":
      return <Path d="m18 15-6-6-6 6" />;
    case "close":
      return (
        <>
          <Path d="M18 6 6 18" />
          <Path d="m6 6 12 12" />
        </>
      );
    case "device":
      return (
        <>
          <Rect x={5} y={3} width={14} height={18} rx={2} />
          <Path d="M10 18h4" />
        </>
      );
    case "edit":
      return (
        <>
          <Path d="M12 20h9" />
          <Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
        </>
      );
    case "eye":
      return (
        <>
          <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <Circle cx={12} cy={12} r={3} />
        </>
      );
    case "eyeOff":
      return (
        <>
          <Path d="m3 3 18 18" />
          <Path d="M10.6 10.6a3 3 0 0 0 2.8 2.8" />
          <Path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a18.7 18.7 0 0 1-2.1 3.1" />
          <Path d="M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7a10.8 10.8 0 0 0 4.1-.8" />
        </>
      );
    case "keyboard":
      return (
        <>
          <Rect x={3} y={5} width={18} height={14} rx={2} />
          <Path d="M7 9h.01M11 9h.01M15 9h.01M19 9h.01M7 13h.01M11 13h.01M15 13h.01M8 17h8" />
        </>
      );
    case "maximize":
      return (
        <>
          <Path d="M8 3H3v5" />
          <Path d="M16 3h5v5" />
          <Path d="M21 16v5h-5" />
          <Path d="M8 21H3v-5" />
        </>
      );
    case "minimize":
      return (
        <>
          <Path d="M8 3v5H3" />
          <Path d="M16 3v5h5" />
          <Path d="M21 16h-5v5" />
          <Path d="M3 16h5v5" />
        </>
      );
    case "more":
      return (
        <>
          <Circle cx={5} cy={12} r={1} fill={color} stroke="none" />
          <Circle cx={12} cy={12} r={1} fill={color} stroke="none" />
          <Circle cx={19} cy={12} r={1} fill={color} stroke="none" />
        </>
      );
    case "plug":
      return (
        <>
          <Path d="M6 3v6" />
          <Path d="M18 3v6" />
          <Path d="M8 9h8v3a4 4 0 0 1-8 0V9Z" />
          <Path d="M12 16v5" />
        </>
      );
    case "provider":
      return (
        <>
          <Rect x={4} y={4} width={6} height={6} rx={1.5} />
          <Rect x={14} y={4} width={6} height={6} rx={1.5} />
          <Rect x={4} y={14} width={6} height={6} rx={1.5} />
          <Rect x={14} y={14} width={6} height={6} rx={1.5} />
        </>
      );
    case "qr":
      return (
        <>
          <Rect x={3} y={3} width={7} height={7} rx={1} />
          <Rect x={14} y={3} width={7} height={7} rx={1} />
          <Rect x={3} y={14} width={7} height={7} rx={1} />
          <Path d="M14 14h2v2h-2zM18 14h3M14 18h3M19 18h2v3h-3" />
        </>
      );
    case "refresh":
      return (
        <>
          <Path d="M21 12a9 9 0 0 1-15.1 6.6" />
          <Path d="M3 12A9 9 0 0 1 18.1 5.4" />
          <Path d="M18 2v4h-4" />
          <Path d="M6 22v-4h4" />
        </>
      );
    case "save":
      return (
        <>
          <Path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
          <Path d="M17 21v-8H7v8" />
          <Path d="M7 3v5h8" />
        </>
      );
    case "send":
      return (
        <>
          <Path d="m22 2-7 20-4-9-9-4 20-7Z" />
          <Path d="M22 2 11 13" />
        </>
      );
    case "settings":
      return (
        <>
          <Path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
          <Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7.1 4l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 20 7.1l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.8.8Z" />
        </>
      );
    case "terminal":
      return (
        <>
          <Path d="m4 17 6-5-6-5" />
          <Path d="M12 19h8" />
        </>
      );
    case "trash":
      return (
        <>
          <Path d="M3 6h18" />
          <Path d="M8 6V4h8v2" />
          <Path d="m19 6-1 14H6L5 6" />
          <Path d="M10 11v5" />
          <Path d="M14 11v5" />
        </>
      );
    case "xCircle":
      return (
        <>
          <Circle cx={12} cy={12} r={9} />
          <Path d="m15 9-6 6" />
          <Path d="m9 9 6 6" />
        </>
      );
  }
}
