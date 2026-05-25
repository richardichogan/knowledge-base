/** One-off script: populates nodes and explicit edges from all existing content. */
import 'dotenv/config';
import { Pool } from 'pg';
import { env } from '../src/config/env.js';
import { syncAllNodes } from '../src/services/nodeService.js';
import { populateExplicitEdges } from '../src/jobs/explicitEdgePopulator.js';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    console.log('Syncing nodes from all content tables...');
    await syncAllNodes(pool);
    const { rows: n } = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM nodes');
    console.log(`Nodes after sync: ${n[0]?.count}`);

    console.log('Populating explicit edges...');
    await populateExplicitEdges(pool);
    const { rows: e } = await pool.query<{ edge_type: string; count: string }>(
      'SELECT edge_type, COUNT(*) AS count FROM edges GROUP BY edge_type ORDER BY count DESC',
    );
    console.log('Edges by type:');
    e.forEach((r) => console.log(`  ${r.edge_type}: ${r.count}`));
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
