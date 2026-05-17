// Assembles the checked optimization suggestions into one runnable, fully
// chained Polars (Python) statement: scan_parquet → with_columns → sort →
// sink_parquet (or collect().write_parquet when a PyArrow-only rule is on).

import type { PolarsDtype, PolarsRule, Suggestion } from "./optimize";

// Render a Polars dtype for the Python API.
function polarsDtype(d: PolarsDtype): string {
  if (d.name === "Datetime") {
    return d.tz ? `pl.Datetime("${d.unit}", "${d.tz}")` : `pl.Datetime("${d.unit}")`;
  }
  if (d.name === "Decimal") return `pl.Decimal(${d.precision}, ${d.scale})`;
  return `pl.${d.name}`;
}

// A Python double-quoted string literal with backslashes/quotes escaped.
function pyStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// One node of a struct-rewrite tree: leaf casts at this level + nested structs.
type StructNode = { casts: Array<[string, PolarsDtype]>; children: Map<string, StructNode> };

function emptyNode(): StructNode {
  return { casts: [], children: new Map() };
}

// Insert a struct-leaf cast. `path` is [root, …mids, leaf]; the root node is
// addressed by the caller, so descend mids and attach the cast at the leaf.
function addLeafCast(root: StructNode, path: string[], dtype: PolarsDtype): void {
  let node = root;
  for (let i = 1; i < path.length - 1; i++) {
    let child = node.children.get(path[i]);
    if (!child) {
      child = emptyNode();
      node.children.set(path[i], child);
    }
    node = child;
  }
  node.casts.push([path[path.length - 1], dtype]);
}

// Render the field expressions passed to `.struct.with_fields(...)`.
function nodeFields(node: StructNode): string[] {
  const out: string[] = [];
  for (const [name, dtype] of node.casts) {
    out.push(`pl.field(${pyStr(name)}).cast(${polarsDtype(dtype)})`);
  }
  for (const [name, child] of node.children) {
    out.push(`pl.field(${pyStr(name)}).struct.with_fields(${nodeFields(child).join(", ")})`);
  }
  return out;
}

export function buildPolarsScript(
  suggestions: Suggestion[],
  selected: Set<string>,
  io: { input: string; output: string },
): string {
  const rules: { rule: PolarsRule; category: Suggestion["category"] }[] = [];
  for (const s of suggestions) {
    if (s.polars && selected.has(s.id)) rules.push({ rule: s.polars, category: s.category });
  }

  // One cast per top-level column: a type-category rule (priority 2) beats an
  // encoding-category `categorical` rule (priority 1) for the same column.
  const colCast = new Map<string, { priority: number; expr: string }>();
  const setCol = (col: string, priority: number, expr: string): void => {
    const cur = colCast.get(col);
    if (!cur || priority > cur.priority) colCast.set(col, { priority, expr });
  };

  const structRoots = new Map<string, StructNode>();
  const sortRules: { column: string; rank: number }[] = [];
  let compression = false;
  let rowGroupRows: number | null = null;
  const bloomCols: string[] = [];
  const encodingEntries: Array<[string, string]> = [];

  for (const { rule, category } of rules) {
    switch (rule.kind) {
      case "cast": {
        if (rule.path.length === 1) {
          setCol(
            rule.path[0],
            2,
            `pl.col(${pyStr(rule.path[0])}).cast(${polarsDtype(rule.dtype)})`,
          );
        } else {
          const root = rule.path[0];
          let node = structRoots.get(root);
          if (!node) {
            node = emptyNode();
            structRoots.set(root, node);
          }
          addLeafCast(node, rule.path, rule.dtype);
        }
        break;
      }
      case "enum":
        setCol(
          rule.column,
          2,
          `pl.col(${pyStr(rule.column)}).cast(pl.Enum([${rule.values.map(pyStr).join(", ")}]))`,
        );
        break;
      case "categorical":
        setCol(
          rule.column,
          category === "type" ? 2 : 1,
          `pl.col(${pyStr(rule.column)}).cast(pl.Categorical)`,
        );
        break;
      case "sort":
        sortRules.push({ column: rule.column, rank: rule.rank });
        break;
      case "compression":
        compression = true;
        break;
      case "rowGroupSize":
        rowGroupRows = rule.rows;
        break;
      case "bloom":
        if (!bloomCols.includes(rule.column)) bloomCols.push(rule.column);
        break;
      case "encoding":
        if (!encodingEntries.some(([c]) => c === rule.column)) {
          encodingEntries.push([rule.column, rule.encoding]);
        }
        break;
    }
  }

  const withColExprs: string[] = [...colCast.values()].map((c) => c.expr);
  for (const [root, node] of structRoots) {
    withColExprs.push(`pl.col(${pyStr(root)}).struct.with_fields(${nodeFields(node).join(", ")})`);
  }

  const sortCols = [...new Set(sortRules.sort((a, b) => a.rank - b.rank).map((s) => s.column))];
  const hasPyarrow = bloomCols.length > 0 || encodingEntries.length > 0;

  const lines: string[] = ["(", `    pl.scan_parquet(${pyStr(io.input)})`];

  if (withColExprs.length > 0) {
    lines.push("    .with_columns(");
    for (const e of withColExprs) lines.push(`        ${e},`);
    lines.push("    )");
  }
  if (sortCols.length > 0) {
    const arg = sortCols.length === 1 ? pyStr(sortCols[0]) : `[${sortCols.map(pyStr).join(", ")}]`;
    lines.push(`    .sort(${arg})`);
  }

  if (hasPyarrow) {
    // bloom / encoding need the eager PyArrow-backed writer.
    lines.push("    .collect()");
    lines.push("    .write_parquet(");
    lines.push(`        ${pyStr(io.output)},`);
    if (compression) lines.push('        compression="zstd",');
    if (rowGroupRows != null) lines.push(`        row_group_size=${rowGroupRows},`);
    lines.push("        use_pyarrow=True,");
    lines.push("        pyarrow_options={");
    if (encodingEntries.length > 0) {
      const enc = encodingEntries.map(([c, e]) => `${pyStr(c)}: ${pyStr(e)}`).join(", ");
      lines.push(`            "column_encoding": {${enc}},`);
    }
    if (bloomCols.length > 0) {
      lines.push(`            "write_bloom_filter": [${bloomCols.map(pyStr).join(", ")}],`);
    }
    lines.push("        },");
    lines.push("    )");
  } else {
    const args = [pyStr(io.output)];
    if (compression) args.push('compression="zstd"');
    if (rowGroupRows != null) args.push(`row_group_size=${rowGroupRows}`);
    lines.push(`    .sink_parquet(${args.join(", ")})`);
  }

  lines.push(")");
  return lines.join("\n");
}
