import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { cpp } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

export function codeEditorLanguageForPath(path: string): Extension[] {
  const extension = getExtension(path);
  switch (extension) {
    case "c":
    case "cc":
    case "cpp":
    case "cxx":
    case "h":
    case "hh":
    case "hpp":
    case "hxx":
      return [StreamLanguage.define(cpp)];
    case "css":
    case "less":
    case "sass":
    case "scss":
      return [css()];
    case "go":
      return [StreamLanguage.define(go)];
    case "htm":
    case "html":
    case "svelte":
    case "vue":
      return [html()];
    case "java":
    case "kt":
    case "kts":
      return [java()];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: extension === "jsx" })];
    case "json":
    case "jsonl":
    case "webmanifest":
      return [json()];
    case "markdown":
    case "md":
      return [markdown()];
    case "php":
      return [php()];
    case "py":
    case "pyw":
      return [python()];
    case "rb":
    case "ruby":
      return [StreamLanguage.define(ruby)];
    case "rs":
      return [rust()];
    case "sh":
      return [StreamLanguage.define(shell)];
    case "sql":
      return [sql()];
    case "swift":
      return [StreamLanguage.define(swift)];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "xml":
    case "svg":
      return [xml()];
    case "yaml":
    case "yml":
      return [StreamLanguage.define(yaml)];
    case "cfg":
    case "conf":
    case "env":
    case "ini":
    case "properties":
      return [StreamLanguage.define(properties)];
    default:
      return [];
  }
}

function getExtension(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}
