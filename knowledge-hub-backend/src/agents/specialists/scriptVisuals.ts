import { registerSpecialist } from '../registry.js';
import { parseScriptVisualInput, resolveScriptVisualSubject, runScriptVisualJob } from '../../services/scriptVisualJobs.js';
import { SCRIPT_VISUAL_SPECIALIST } from '../../utils/scriptVisualJobs.js';

registerSpecialist({
  id: SCRIPT_VISUAL_SPECIALIST,
  name: 'Ariadne — Script visual designer',
  description: 'Designs script visuals in the background and retains a pending result for explicit review and application. Use design_script_visuals or the script toolbar, not a generic handoff.',
  subjectType: 'script-visuals',
  resolveSubject: resolveScriptVisualSubject,
  parseInput: parseScriptVisualInput,
  run: runScriptVisualJob,
});
