import type { DuckDBType, FormatResult } from "./types";

export const numberFmt = new Intl.NumberFormat(undefined);
export const floatFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 12 });

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0 B";
  const i = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log10(Math.abs(n)) / 3));
  const v = n / 1000 ** i;
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${BYTE_UNITS[i]}`;
}

export function formatRatio(num: number | undefined, den: number | undefined): string {
  if (!num || !den) return "—";
  return `${(num / den).toFixed(2)}×`;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeMaybeBytes(v: unknown): { text: string; binary: boolean } {
  if (v == null) return { text: "", binary: false };
  if (typeof v === "string") return { text: v, binary: false };
  if (v instanceof Uint8Array) {
    try {
      return { text: utf8Decoder.decode(v), binary: false };
    } catch {
      const preview = Array.from(v.slice(0, 96))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      return {
        text: `<${v.length} bytes>  ${preview}${v.length > 96 ? " …" : ""}`,
        binary: true,
      };
    }
  }
  return { text: String(v), binary: false };
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  return value;
}

export function materialize(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(materialize);
  const anyV = v as { length?: number; toArray?: () => unknown[]; toJSON?: () => unknown };
  if (typeof anyV.length === "number" && typeof anyV.toArray === "function") {
    return Array.from({ length: anyV.length }, (_, i) =>
      materialize((anyV as unknown as Record<number, unknown>)[i]),
    );
  }
  if (typeof anyV.toJSON === "function") {
    const obj = anyV.toJSON() as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k in obj) out[k] = materialize(obj[k]);
    return out;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k in v as Record<string, unknown>) {
      out[k] = materialize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function pad(n: number | bigint, width: number): string {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

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

function formatTimestampUnit(value: bigint | number, unit: "S" | "MS" | "US" | "NS", tz: boolean) {
  let micros: bigint;
  if (typeof value === "bigint") {
    if (unit === "S") micros = value * 1000000n;
    else if (unit === "MS") micros = value * 1000n;
    else if (unit === "US") micros = value;
    else micros = value / 1000n;
  } else {
    if (unit === "S") micros = BigInt(Math.round(value * 1000000));
    else if (unit === "MS") micros = BigInt(Math.round(value * 1000));
    else if (unit === "US") micros = BigInt(Math.round(value));
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
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1, 2)}-${pad(
      value.getUTCDate(),
      2,
    )}`;
  }
  if (typeof value === "number") {
    return formatDate(new Date(value * 86400000));
  }
  if (typeof value === "bigint") {
    return formatDate(new Date(Number(value) * 86400000));
  }
  return String(value);
}

function formatInterval(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { months?: number; days?: number; micros?: bigint | number };
    const months = o.months ?? 0;
    const days = o.days ?? 0;
    const micros = typeof o.micros === "bigint" ? o.micros : BigInt(o.micros ?? 0);
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
  return String(v);
}

export function formatCell(value: unknown, type: DuckDBType): FormatResult {
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
    case "FLOAT":
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
    case "VARCHAR":
    case "JSON":
    case "UUID":
    case "ENUM": {
      const s = String(value);
      if (s.length > 200) return { display: "text", text: `${s.slice(0, 197)}…` };
      return { display: "text", text: s };
    }
    case "BLOB": {
      const u8 = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      return { display: "blob", bytes: u8 };
    }
    case "DATE":
      return { display: "text", text: formatDate(value) };
    case "TIME":
      return { display: "text", text: formatTime(value as bigint | number, type.tz) };
    case "TIMESTAMP":
      return {
        display: "text",
        text: formatTimestampUnit(value as bigint | number, type.unit, type.tz),
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
