export const WORKFORCE_DEFINITION_VERSION = 'imagine-workforce-specification-v1';
export const WORKFORCE_DEFINITION_MARKER = `Specification contract: ${WORKFORCE_DEFINITION_VERSION}`;
export const WORKFORCE_DEFINITION_AREAS = [
  'Member properties', 'Governance and refusal rules', 'Orchestration and handoffs',
  'Hierarchy', 'Ownership', 'Observability definitions', 'Dependencies and composition',
  'Design-time coverage and maturity', 'Evaluation definitions',
] as const;

export const WORKFORCE_DEFINITION_BOUNDARY = `This Design is limited to authoring an undeployed Imagine workforce blueprint.
The full demo template is valid for later phases, but is NOT this Design's current delivery scope.
Cover member properties, governance/refusal definitions, orchestration/typed handoffs/human waits/failure paths, hierarchy, ownership, observability event definitions, dependencies/composition/BOM, design-time coverage/maturity, and eval definitions.
Use confirmed business facts and the authoritative Use Case. Do not copy deployment assumptions from an older full-demo Spec or visual.
Define proposed worker behavior; do not require worker/workflow code, actual invocation, enforced runtime controls, durable runtime receipts or executed eval results.
Tools, data access, Foundry/IQ/Fabric/Cosmos dependencies and future integration requirements are definitions or proposals, not connected services or provisioned resources.
Do not introduce Outcomes 2-5, G2-G7, Teams/M365 channel implementations, application release, telemetry dashboards, generated synthetic datasets or demo creation.
Any screen illustration is a proposed Imagine definition view, not a new business application or a live action.
The Think Blueprint is a review artifact. The final Imagine workforce blueprint must be persisted and read back before claiming it exists there.
Definition completeness is not a pass of the native G1 structural-and-behavioral acceptance gate.
Stop at saved undeployed definitions. Execution, deployment, publication, resources, eval runs and demo creation require a later, separately authorized phase.`;
