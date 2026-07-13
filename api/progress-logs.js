/* Sidekick — api/progress-logs.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `progressLogs` IndexedDB store (app.js) — per-client weight/notes entries
 * over time. Table is named `progress_logs`; file hyphenated to match this
 * project's existing multi-word api/*.js naming (see api/app-bookings.js,
 * api/booking-availability.js).
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = ['client_id', 'date', 'weight', 'notes'];

export default createResourceHandler('progress_logs', FIELDS);
export const config = { runtime: 'edge' };
