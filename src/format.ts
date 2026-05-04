// Format-agnostic helpers used by both the UI shell and parquet-specific
// formatters. Anything that dispatches on a parquet ParquetType.kind lives in
// src/formats/parquet/format.ts instead.

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

export function pad(n: number | bigint, width: number): string {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}
