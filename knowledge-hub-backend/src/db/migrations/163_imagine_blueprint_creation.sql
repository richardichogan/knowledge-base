CREATE TABLE IF NOT EXISTS design_imagine_blueprint_creations (
  design_id UUID PRIMARY KEY REFERENCES designs(id),
  operation_id UUID NOT NULL UNIQUE,
  binding JSONB NOT NULL,
  definition JSONB NOT NULL,
  journal JSONB NOT NULL DEFAULT '{"receipts":{}}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
