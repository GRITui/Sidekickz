/* Sidekick — api/services.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `services` IndexedDB store, including the usageQty/rate/unit fields.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = ['name', 'rate', 'unit', 'usage_qty'];

export default createResourceHandler('services', FIELDS);
export const config = { runtime: 'edge' };
