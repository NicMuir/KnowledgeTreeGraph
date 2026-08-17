-- Resolution confidence for symbol edges (0..1). Nullable: existing rows and
-- structural edges (contains) have no score. Also documents the new http_calls edge kind.
ALTER TABLE "symbol_edges" ADD COLUMN "confidence" DOUBLE PRECISION;
