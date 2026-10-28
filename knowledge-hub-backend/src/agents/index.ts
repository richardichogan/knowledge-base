/** agents/index.ts — registers every specialist and exposes the job engine. */
import './specialists/design.js';
import './specialists/blog.js';

export * from './engine.js';
export { getSpecialist, listSpecialists } from './registry.js';
