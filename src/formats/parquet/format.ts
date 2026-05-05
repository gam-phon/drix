// Parquet-aware cell formatter. Dispatches on ParquetType.kind to render
// values from DuckDB-WASM (BigInt for INT64/INT128, Date for DATE, microsecond
// bigints for TIME/TIMESTAMP, Arrow row proxies for STRUCT/LIST/MAP, …).

import { floatFmt, jsonReplacer, materialize, numberFmt, pad } from "../../format";
import type { ParquetType } from "./types";

export type FormatResult =
  | { display: "text"; text: string }
  | { display: "muted"; text: string }
  | { display: "tree"; preview: string; value: unknown }
  | { display: "blob"; bytes: Uint8Array };

function formatTimestampMicros(micros: bigint, tz: boolean): string {
  const ms = Number(micros / 1000n);
  const usPart = Number(micros % 1000000n);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return micros.toString();
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(
    d.getUTCDate(),
    2,
  )}T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(
    Math.abs(usPart),
    6,
  )}`;
  return tz ? `${iso}Z` : iso;
}

function formatTimestampUnit(
  value: bigint | number,
  unit: "MILLIS" | "MICROS" | "NANOS",
  tz: boolean,
) {
  let micros: bigint;
  if (typeof value === "bigint") {
    if (unit === "MILLIS") micros = value * 1000n;
    else if (unit === "MICROS") micros = value;
    else micros = value / 1000n; // NANOS
  } else {
    if (unit === "MILLIS") micros = BigInt(Math.round(value * 1000));
    else if (unit === "MICROS") micros = BigInt(Math.round(value));
    else micros = BigInt(Math.round(value / 1000));
  }
  return formatTimestampMicros(micros, tz);
}

function formatTime(value: bigint | number, tz: boolean): string {
  const micros = typeof value === "bigint" ? value : BigInt(Math.round(value));
  const totalSec = micros / 1000000n;
  const us = micros % 1000000n;
  const h = totalSec / 3600n;
  const m = (totalSec % 3600n) / 60n;
  const s = totalSec % 60n;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(Number(us < 0n ? -us : us), 6)}${tz ? "Z" : ""}`;
}

function formatDate(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) {
      return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1, 2)}-${pad(
        value.getUTCDate(),
        2,
      )}`;
    }
    return String(value);
  }
  if (typeof value === "string") return value;
  // Apache Arrow's DateDay/DateMillisecond getter already converts to
  // milliseconds-since-epoch — it does the days × 86_400_000 multiplication
  // for us. Multiplying again here is what made dates render as NaN-NaN-NaN.
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatDate(new Date(value));
  }
  if (typeof value === "bigint") {
    const n = Number(value);
    if (Number.isFinite(n)) return formatDate(new Date(n));
  }
  return String(value);
}

function formatInterval(v: unknown): string {
  if (v == null) return "";
  // Unwrap Arrow row proxies that hide their fields behind toJSON().
  let raw: unknown = v;
  const arrowLike = v as { toJSON?: () => unknown };
  if (typeof v === "object" && typeof arrowLike.toJSON === "function") {
    try {
      raw = arrowLike.toJSON();
    } catch {
      // fall through with original v
    }
  }
  if (typeof raw !== "object" || raw == null) return String(raw ?? "");
  const o = raw as Record<string, unknown>;

  const months = Number(o.months ?? 0);
  const days = Number(o.days ?? 0);
  // Sub-day component: DuckDB Node API uses `micros`; Apache Arrow JS uses
  // `nanoseconds` (MonthDayNano interval). DuckDB-WASM goes through Arrow, so
  // the browser path lands on `nanoseconds`. Some writers also expose
  // `milliseconds`. Normalise everything to microseconds.
  const toBig = (x: unknown): bigint => {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(Math.round(x));
    if (x == null) return 0n;
    try {
      return BigInt(String(x));
    } catch {
      return 0n;
    }
  };
  let micros: bigint;
  if (o.micros != null) {
    micros = toBig(o.micros);
  } else if (o.nanoseconds != null) {
    micros = toBig(o.nanoseconds) / 1000n;
  } else if (o.milliseconds != null) {
    micros = toBig(o.milliseconds) * 1000n;
  } else {
    micros = 0n;
  }

  const sec = Number(micros / 1000000n);
  const us = Number(micros % 1000000n);
  const parts: string[] = [];
  if (months) parts.push(`${months} mo`);
  if (days) parts.push(`${days} d`);
  if (sec || us) {
    const subSec = us !== 0 ? `.${pad(Math.abs(us), 6)}` : "";
    parts.push(`${sec}${subSec} s`);
  }
  return parts.length > 0 ? parts.join(" ") : "0";
}

export function formatCell(value: unknown, type: ParquetType): FormatResult {
  if (value == null) return { display: "muted", text: "NULL" };
  switch (type.kind) {
    case "BOOLEAN":
      return { display: "text", text: value ? "true" : "false" };
    case "INT": {
      if (type.bits >= 64 && typeof value === "bigint") {
        return { display: "text", text: value.toString() };
      }
      if (typeof value === "bigint")
        return { display: "text", text: numberFmt.format(Number(value)) };
      return { display: "text", text: numberFmt.format(value as number) };
    }
    case "INT96":
      return {
        display: "text",
        text: typeof value === "bigint" ? value.toString() : String(value),
      };
    case "FLOAT":
    case "FLOAT16":
    case "DOUBLE": {
      const n = typeof value === "bigint" ? Number(value) : (value as number);
      return { display: "text", text: floatFmt.format(n) };
    }
    case "DECIMAL": {
      if (typeof value === "string") return { display: "text", text: value };
      if (typeof value === "bigint") {
        const s = value.toString();
        if (type.scale <= 0) return { display: "text", text: s };
        const neg = s.startsWith("-");
        const digits = neg ? s.slice(1) : s;
        const padded = digits.padStart(type.scale + 1, "0");
        const intPart = padded.slice(0, -type.scale);
        const fracPart = padded.slice(-type.scale);
        return { display: "text", text: `${neg ? "-" : ""}${intPart}.${fracPart}` };
      }
      if (typeof value === "number") return { display: "text", text: value.toFixed(type.scale) };
      return { display: "text", text: String(value) };
    }
    case "STRING":
    case "JSON":
    case "UUID":
    case "ENUM": {
      const s = String(value);
      if (s.length > 200) return { display: "text", text: `${s.slice(0, 197)}…` };
      return { display: "text", text: s };
    }
    case "BSON":
    case "BYTE_ARRAY":
    case "FIXED_LEN_BYTE_ARRAY": {
      const u8 = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      return { display: "blob", bytes: u8 };
    }
    case "DATE":
      return { display: "text", text: formatDate(value) };
    case "TIME":
      return {
        display: "text",
        text: formatTime(value as bigint | number, type.adjustedToUTC),
      };
    case "TIMESTAMP":
      return {
        display: "text",
        text: formatTimestampUnit(value as bigint | number, type.unit, type.adjustedToUTC),
      };
    case "INTERVAL":
      return { display: "text", text: formatInterval(value) };
    case "LIST": {
      const m = materialize(value) as unknown[];
      return {
        display: "tree",
        preview: `[${m.length} item${m.length === 1 ? "" : "s"}]`,
        value: m,
      };
    }
    case "STRUCT": {
      const m = materialize(value) as Record<string, unknown>;
      const keys = Object.keys(m);
      const preview = `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
      return { display: "tree", preview, value: m };
    }
    case "MAP": {
      const m = materialize(value);
      const arr = Array.isArray(m) ? m : [];
      return { display: "tree", preview: `{${arr.length} entries}`, value: m };
    }
    default:
      try {
        return { display: "text", text: JSON.stringify(value, jsonReplacer) };
      } catch {
        return { display: "text", text: String(value) };
      }
  }
}
