import { quoteLiteral } from "../../query";
import type { FormatAdapter } from "../../types";
import { fetchParquetFileInfo } from "./file-info";
import { fetchParquetSchema } from "./schema";
import type { ParquetFileInfo } from "./types";

export const parquetAdapter: FormatAdapter<ParquetFileInfo> = {
  name: "parquet",
  extensions: [".parquet", ".pq"],
  fromExpr: (alias) => `read_parquet(${quoteLiteral(alias)})`,
  fetchSchema: fetchParquetSchema,
  fetchFileInfo: fetchParquetFileInfo,
};
