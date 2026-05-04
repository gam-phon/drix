import type { DuckDBType } from "./types";

export function parseDuckDBType(input: string): DuckDBType {
  const s = input.trim();

  // LIST: trailing [] (check first so STRUCT(...)[] works)
  if (s.endsWith("[]")) {
    return { kind: "LIST", element: parseDuckDBType(s.slice(0, -2).trim()) };
  }

  const upper = s.toUpperCase();

  if (upper.startsWith("STRUCT(")) {
    const inside = stripWrap(s, "STRUCT(", ")");
    const parts = splitTopLevel(inside, ",").map((p) => p.trim());
    const fields = parts.map((p) => {
      const space = findFirstTopLevelSpace(p);
      if (space < 0) throw new Error(`Bad struct field: ${p}`);
      const name = unquoteIdent(p.slice(0, space).trim());
      const type = parseDuckDBType(p.slice(space + 1).trim());
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
      key: parseDuckDBType(parts[0]),
      value: parseDuckDBType(parts[1]),
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
      return { kind: "VARCHAR" };
    case "BLOB":
    case "BYTEA":
    case "BINARY":
    case "VARBINARY":
      return { kind: "BLOB" };
    case "UUID":
      return { kind: "UUID" };
    case "JSON":
      return { kind: "JSON" };
    case "DATE":
      return { kind: "DATE" };
    case "TIME":
      return { kind: "TIME", tz: false };
    case "TIME WITH TIME ZONE":
    case "TIMETZ":
      return { kind: "TIME", tz: true };
    case "TIMESTAMP":
    case "DATETIME":
      return { kind: "TIMESTAMP", unit: "US", tz: false };
    case "TIMESTAMP_S":
      return { kind: "TIMESTAMP", unit: "S", tz: false };
    case "TIMESTAMP_MS":
      return { kind: "TIMESTAMP", unit: "MS", tz: false };
    case "TIMESTAMP_NS":
      return { kind: "TIMESTAMP", unit: "NS", tz: false };
    case "TIMESTAMP WITH TIME ZONE":
    case "TIMESTAMPTZ":
      return { kind: "TIMESTAMP", unit: "US", tz: true };
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

export function typeChipString(t: DuckDBType): string {
  switch (t.kind) {
    case "BOOLEAN":
      return "BOOL";
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
    case "DECIMAL":
      return `DECIMAL(${t.precision},${t.scale})`;
    case "VARCHAR":
      return "VARCHAR";
    case "BLOB":
      return "BLOB";
    case "UUID":
      return "UUID";
    case "JSON":
      return "JSON";
    case "DATE":
      return "DATE";
    case "TIME":
      return t.tz ? "TIMETZ" : "TIME";
    case "TIMESTAMP": {
      const base = t.unit === "US" ? "TIMESTAMP" : `TIMESTAMP_${t.unit}`;
      return t.tz ? `${base}TZ` : base;
    }
    case "INTERVAL":
      return "INTERVAL";
    case "ENUM":
      return "ENUM";
    case "LIST":
      return `${typeChipString(t.element)}[]`;
    case "MAP":
      return `MAP(${typeChipString(t.key)}, ${typeChipString(t.value)})`;
    case "STRUCT":
      return `STRUCT(${t.fields.map((f) => `${f.name} ${typeChipString(f.type)}`).join(", ")})`;
    default:
      return t.raw;
  }
}

export function isFilterableSimple(t: DuckDBType): boolean {
  switch (t.kind) {
    case "LIST":
    case "MAP":
    case "STRUCT":
    case "BLOB":
    case "UNKNOWN":
      return false;
    default:
      return true;
  }
}

export function castExpr(t: DuckDBType): string | null {
  switch (t.kind) {
    case "DATE":
      return "DATE";
    case "TIME":
      return t.tz ? "TIMETZ" : "TIME";
    case "TIMESTAMP": {
      const base = t.unit === "US" ? "TIMESTAMP" : `TIMESTAMP_${t.unit}`;
      return t.tz ? `${base}TZ` : base;
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
    default:
      return null;
  }
}
