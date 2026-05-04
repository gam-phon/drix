import type { ParquetType } from "./types";

// Parse a DuckDB-flavoured type string (the form returned by `DESCRIBE`,
// e.g. "BIGINT", "STRUCT(a INTEGER, b VARCHAR)", "TIMESTAMPTZ") and emit a
// parquet-flavoured ParquetType. We keep this DuckDB-aware because the SQL
// tab and DESCRIBE on a parquet source both hand us DuckDB type strings —
// only the *output* model is parquet.
//
// For loaded parquet files, prefer the richer parquet_schema-based parser in
// src/formats/parquet/schema.ts which has access to physical/logical/converted
// types directly.
export function parseParquetType(input: string): ParquetType {
  const s = input.trim();

  // LIST: trailing [] (check first so STRUCT(...)[] works)
  if (s.endsWith("[]")) {
    return { kind: "LIST", element: parseParquetType(s.slice(0, -2).trim()) };
  }

  const upper = s.toUpperCase();

  if (upper.startsWith("STRUCT(")) {
    const inside = stripWrap(s, "STRUCT(", ")");
    const parts = splitTopLevel(inside, ",").map((p) => p.trim());
    const fields = parts.map((p) => {
      const space = findFirstTopLevelSpace(p);
      if (space < 0) throw new Error(`Bad struct field: ${p}`);
      const name = unquoteIdent(p.slice(0, space).trim());
      const type = parseParquetType(p.slice(space + 1).trim());
      return { name, type };
    });
    return { kind: "STRUCT", fields };
  }

  if (upper.startsWith("MAP(")) {
    const inside = stripWrap(s, "MAP(", ")");
    const parts = splitTopLevel(inside, ",").map((p) => p.trim());
    if (parts.length !== 2) throw new Error(`Bad map: ${s}`);
    return {
      kind: "MAP",
      key: parseParquetType(parts[0]),
      value: parseParquetType(parts[1]),
    };
  }

  const dec = /^(?:DECIMAL|NUMERIC)\((\d+)\s*,\s*(\d+)\)$/i.exec(s);
  if (dec) {
    return {
      kind: "DECIMAL",
      precision: Number.parseInt(dec[1], 10),
      scale: Number.parseInt(dec[2], 10),
    };
  }

  if (upper.startsWith("ENUM(")) {
    const inside = stripWrap(s, "ENUM(", ")");
    const values = splitTopLevel(inside, ",").map((p) => {
      const t = p.trim();
      return t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t;
    });
    return { kind: "ENUM", values };
  }

  switch (upper) {
    case "BOOLEAN":
    case "BOOL":
      return { kind: "BOOLEAN" };
    case "TINYINT":
    case "INT1":
      return { kind: "INT", bits: 8, signed: true };
    case "SMALLINT":
    case "INT2":
      return { kind: "INT", bits: 16, signed: true };
    case "INTEGER":
    case "INT":
    case "INT4":
      return { kind: "INT", bits: 32, signed: true };
    case "BIGINT":
    case "INT8":
      return { kind: "INT", bits: 64, signed: true };
    case "HUGEINT":
      return { kind: "INT", bits: 128, signed: true };
    case "UTINYINT":
      return { kind: "INT", bits: 8, signed: false };
    case "USMALLINT":
      return { kind: "INT", bits: 16, signed: false };
    case "UINTEGER":
      return { kind: "INT", bits: 32, signed: false };
    case "UBIGINT":
      return { kind: "INT", bits: 64, signed: false };
    case "UHUGEINT":
      return { kind: "INT", bits: 128, signed: false };
    case "FLOAT":
    case "REAL":
    case "FLOAT4":
      return { kind: "FLOAT" };
    case "DOUBLE":
    case "FLOAT8":
      return { kind: "DOUBLE" };
    case "VARCHAR":
    case "TEXT":
    case "STRING":
    case "CHAR":
      return { kind: "STRING" };
    case "BLOB":
    case "BYTEA":
    case "BINARY":
    case "VARBINARY":
      return { kind: "BYTE_ARRAY" };
    case "UUID":
      return { kind: "UUID" };
    case "JSON":
      return { kind: "JSON" };
    case "DATE":
      return { kind: "DATE" };
    case "TIME":
      return { kind: "TIME", unit: "MICROS", adjustedToUTC: false };
    case "TIME WITH TIME ZONE":
    case "TIMETZ":
      return { kind: "TIME", unit: "MICROS", adjustedToUTC: true };
    case "TIMESTAMP":
    case "DATETIME":
      return { kind: "TIMESTAMP", unit: "MICROS", adjustedToUTC: false };
    case "TIMESTAMP_S":
      // Parquet has no second precision; round up to MICROS.
      return { kind: "TIMESTAMP", unit: "MICROS", adjustedToUTC: false };
    case "TIMESTAMP_MS":
      return { kind: "TIMESTAMP", unit: "MILLIS", adjustedToUTC: false };
    case "TIMESTAMP_NS":
      return { kind: "TIMESTAMP", unit: "NANOS", adjustedToUTC: false };
    case "TIMESTAMP WITH TIME ZONE":
    case "TIMESTAMPTZ":
      return { kind: "TIMESTAMP", unit: "MICROS", adjustedToUTC: true };
    case "INTERVAL":
      return { kind: "INTERVAL" };
    default:
      return { kind: "UNKNOWN", raw: s };
  }
}

function stripWrap(s: string, prefix: string, suffix: string): string {
  if (!s.toUpperCase().startsWith(prefix.toUpperCase()) || !s.endsWith(suffix)) {
    throw new Error(`Bad wrap: ${s}`);
  }
  return s.slice(prefix.length, s.length - suffix.length);
}

function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      buf += c;
      if (c === "'") {
        if (s[i + 1] === "'") {
          buf += s[++i];
        } else {
          inStr = false;
        }
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      buf += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === delim && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function findFirstTopLevelSpace(s: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "'") {
        if (s[i + 1] === "'") {
          i++;
        } else {
          inStr = false;
        }
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === " " && depth === 0) return i;
  }
  return -1;
}

function unquoteIdent(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
  return s;
}

// Renders the parquet-flavoured type label for a column.
export function typeChipString(t: ParquetType): string {
  switch (t.kind) {
    case "BOOLEAN":
      return "BOOLEAN";
    case "INT":
      return `${t.signed ? "INT" : "UINT"}${t.bits}`;
    case "INT96":
      return "INT96";
    case "FLOAT":
      return "FLOAT";
    case "FLOAT16":
      return "FLOAT16";
    case "DOUBLE":
      return "DOUBLE";
    case "DECIMAL":
      return `DECIMAL(${t.precision}, ${t.scale})`;
    case "STRING":
      return "STRING";
    case "BYTE_ARRAY":
      return "BYTE_ARRAY";
    case "FIXED_LEN_BYTE_ARRAY":
      return `FIXED_LEN_BYTE_ARRAY(${t.length})`;
    case "UUID":
      return "UUID";
    case "JSON":
      return "JSON";
    case "BSON":
      return "BSON";
    case "DATE":
      return "DATE";
    case "TIME":
      return t.adjustedToUTC ? `TIME(${t.unit}, UTC)` : `TIME(${t.unit})`;
    case "TIMESTAMP":
      return t.adjustedToUTC ? `TIMESTAMP(${t.unit}, UTC)` : `TIMESTAMP(${t.unit})`;
    case "INTERVAL":
      return "INTERVAL";
    case "ENUM":
      return "ENUM";
    case "LIST":
      return `LIST<${typeChipString(t.element)}>`;
    case "MAP":
      return `MAP<${typeChipString(t.key)}, ${typeChipString(t.value)}>`;
    case "STRUCT":
      return `STRUCT<${t.fields.map((f) => `${f.name}: ${typeChipString(f.type)}`).join(", ")}>`;
    default:
      return t.raw;
  }
}

export function isFilterableSimple(t: ParquetType): boolean {
  switch (t.kind) {
    case "LIST":
    case "MAP":
    case "STRUCT":
    case "BYTE_ARRAY":
    case "FIXED_LEN_BYTE_ARRAY":
    case "INT96":
    case "BSON":
    case "UNKNOWN":
      return false;
    default:
      return true;
  }
}

// Maps a ParquetType to a DuckDB-flavoured CAST target for filter predicate
// generation. SQL is still executed by DuckDB so we hand it back its own
// type names (BIGINT not INT64, VARCHAR not STRING, etc.).
export function castExpr(t: ParquetType): string | null {
  switch (t.kind) {
    case "DATE":
      return "DATE";
    case "TIME":
      return t.adjustedToUTC ? "TIMETZ" : "TIME";
    case "TIMESTAMP": {
      if (t.adjustedToUTC) return "TIMESTAMPTZ";
      switch (t.unit) {
        case "MILLIS":
          return "TIMESTAMP_MS";
        case "NANOS":
          return "TIMESTAMP_NS";
        default:
          return "TIMESTAMP";
      }
    }
    case "DECIMAL":
      return `DECIMAL(${t.precision},${t.scale})`;
    case "INT": {
      const u = t.signed ? "" : "U";
      const name =
        t.bits === 8
          ? "TINYINT"
          : t.bits === 16
            ? "SMALLINT"
            : t.bits === 32
              ? "INTEGER"
              : t.bits === 64
                ? "BIGINT"
                : "HUGEINT";
      return `${u}${name}`;
    }
    case "FLOAT":
      return "FLOAT";
    case "DOUBLE":
      return "DOUBLE";
    case "BOOLEAN":
      return "BOOLEAN";
    case "INTERVAL":
      return "INTERVAL";
    case "UUID":
      return "UUID";
    case "STRING":
      return "VARCHAR";
    case "JSON":
      return "JSON";
    default:
      return null;
  }
}
