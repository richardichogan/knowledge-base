/**
 * seeds/conceptTaxonomy.ts
 * Idempotent seed for the approved concept tag taxonomy.
 * Run via: npm run taxonomy:seed
 *
 * Each parent tag is inserted with role='concept'.
 * Children inherit their parent's colour.
 * Acronym tags receive a description for hover tooltips.
 * Running twice produces no duplicates.
 */
import 'dotenv/config';
import { getDb } from '../db/db.js';

/** Seven concept parent groups with their children. */
const CONCEPT_TAXONOMY: Record<string, string[]> = {
  'Microsoft Cloud': [
    'Azure', 'Azure DevOps', 'Microsoft 365', 'Dynamics 365',
    'Power Platform', 'Microsoft Entra', 'Microsoft Foundry',
    'GitHub', 'AKS', 'Microsoft Fabric', 'Azure Local', 'Sovereign Cloud',
    'SharePoint', 'Teams', 'Power Pages', 'Adoption',
  ],
  'AI': [
    'Models', 'Agentic', 'MCP', 'RAG', 'Generative AI',
    'Copilot', 'Microsoft 365 Copilot', 'Copilot Studio',
    'GitHub Copilot', 'Microsoft Agent Framework', 'AI Architecture',
  ],
  'Security and Identity': [
    'Zero Trust', 'SASE', 'Identity Governance', 'Threat Detection',
    'Cloud Security', 'Compliance', 'Privileged Access',
    'Vulnerability Management', 'Email Security', 'Privacy',
  ],
  'DevOps and Automation': [
    'Infrastructure as Code', 'Terraform', 'GitHub Actions', 'CI/CD',
    'Azure Verified Modules', 'EPAC', 'Self-healing Infrastructure',
    'Pipeline Modernization', 'Container Orchestration', 'KEDA',
  ],
  'Architecture and Method': [
    'Well-Architected', 'Cloud Adoption Framework', 'Modernization',
    'Migration', 'Multi-cloud', 'Reference Architecture',
    'Solution Design', 'Architectural Decision', 'Patterns',
  ],
  'Observability and Data': [
    'Azure Monitor', 'Telemetry', 'FinOps', 'Cost Optimization',
    'Databases', 'Analytics', 'AI for Operations', 'Drift Detection',
    'Root Cause Analysis', 'Knowledge Management',
  ],
  'Industry': [
    'Financial Services', 'Legal', 'Healthcare',
    'Public Sector', 'Manufacturing', 'Retail',
  ],
};

/** Descriptions for acronym-heavy tags shown on hover in TagPicker. */
const TAG_DESCRIPTIONS: Record<string, string> = {
  'MCP':    'Model Context Protocol — Anthropic-originated standard for tool integration',
  'EPAC':   'Enterprise Policy as Code',
  'AKS':    'Azure Kubernetes Service',
  'SASE':   'Secure Access Service Edge',
  'RAG':    'Retrieval Augmented Generation',
  'KEDA':   'Kubernetes Event-driven Autoscaling',
  'CI/CD':  'Continuous Integration and Continuous Delivery',
  'Models': 'Foundation models — language, voice, image, embedding',
  'Agentic':'Agentic patterns, multi-agent systems, autonomous agents',
};

/** Colours cycled across concept parent groups. */
const COLOURS = [
  '#0f62fe', '#6929c4', '#009d9a', '#1192e8', '#005d5d',
  '#9f1853', '#fa4d56',
];

function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function seedConceptTaxonomy(): Promise<void> {
  const db = getDb();
  const parents = Object.keys(CONCEPT_TAXONOMY);

  for (let i = 0; i < parents.length; i++) {
    const parentName = parents[i]!;
    const colour = COLOURS[i % COLOURS.length]!;
    const parentSlug = toSlug(parentName);

    // Upsert parent — skip if slug already exists
    const parentRow = await db.query<{ id: string }>(
      `INSERT INTO tags (name, slug, role, colour)
       VALUES ($1, $2, 'concept', $3)
       ON CONFLICT (slug) DO UPDATE SET role = 'concept', updated_at = now()
       RETURNING id`,
      [parentName, parentSlug, colour],
    );
    const parentId = parentRow.rows[0]!.id;
    console.warn(`[Seed] Parent: ${parentName} (${parentId})`);

    for (const childName of CONCEPT_TAXONOMY[parentName]!) {
      const childSlug = toSlug(childName);
      const description = TAG_DESCRIPTIONS[childName] ?? null;
      await db.query(
        `INSERT INTO tags (name, slug, role, parent_id, colour)
         VALUES ($1, $2, 'concept', $3, $4)
         ON CONFLICT (slug) DO UPDATE SET role = 'concept', parent_id = $3, updated_at = now()`,
        [childName, childSlug, parentId, colour],
      );
      if (description) {
        // Store description in metadata — add column if not present
        await db.query(
          `UPDATE tags SET description = $1 WHERE slug = $2`,
          [description, childSlug],
        ).catch(() => {
          // Column may not exist yet — safe to ignore during seed
        });
      }
      console.warn(`  [Seed] Child: ${childName}`);
    }
  }

  console.warn('[Seed] Concept taxonomy seeded successfully.');
  await db.end();
}

seedConceptTaxonomy().catch((err: unknown) => {
  console.error('[Seed] Failed:', err);
  process.exit(1);
});
