-- Migration 019: Connections graph — nodes and edges

CREATE TABLE IF NOT EXISTS nodes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_id     TEXT        NOT NULL,
  ref_type   TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  tags       TEXT[]      NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ref_id, ref_type)
);

CREATE INDEX IF NOT EXISTS idx_nodes_ref  ON nodes(ref_id, ref_type);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(ref_type);

CREATE TABLE IF NOT EXISTS edges (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  source_node_id UUID          NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id UUID          NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  edge_type      TEXT          NOT NULL,
  confidence     NUMERIC(3,2)  NOT NULL DEFAULT 1.0,
  metadata       JSONB,
  created_at     TIMESTAMPTZ   DEFAULT now(),
  UNIQUE (source_node_id, target_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_type   ON edges(edge_type);
