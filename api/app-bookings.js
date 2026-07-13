/* Sidekick — api/app-bookings.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `bookings` IndexedDB store (app/bookings.js). Named `app_bookings` /
 * `app-bookings.js` (not the bare `bookings` name) because sql/schema.sql —
 * a separate, single-tenant schema for the LINE self-service booking pilot —
 * already owns an unrelated `bookings` table; both schemas load into the
 * same Neon database, so the names must not collide.
 *
 * `created_at` is deliberately left out of FIELDS — see sql/schema-core.sql's
 * note on why it's a server-assigned, update-immune column here.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = [
  'customer_id', 'title', 'date', 'start_time', 'duration_min',
  'travel_buffer_min', 'location', 'notes', 'status',
];

export default createResourceHandler('app_bookings', FIELDS);
export const config = { runtime: 'edge' };
