import { registerSpecialist } from '../registry.js';
import { prepareDiagramInput, resolveDiagramSubject, runDiagramDesigner } from '../../services/diagramCandidates.js';

registerSpecialist({
  id: 'daedalus',
  name: 'Daedalus — Diagram designer',
  description: 'Creates a separate editable diagram candidate from the current diagram, the conversation and supplied reference screenshots. Uses saved diagrams as layout examples. Original diagrams are never overwritten by generation. Use subjectId for the existing diagram, or new:<chat-session-UUID> for a new diagram. Pass the current diagram revision and any reference diagram/screen IDs. Use for drawing, redrawing, matching an image and substantial layout changes; ordinary small edits can stay with Athena.',
  subjectType: 'diagram',
  resolveSubject: resolveDiagramSubject,
  parseInput: prepareDiagramInput,
  run: runDiagramDesigner,
});
