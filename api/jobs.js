/* Sidekick — api/jobs.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the `jobs`
 * IndexedDB store. subTasks/milestones/timeEntries/stageOrder are embedded
 * arrays on the job record itself in the client today — mirrored here as
 * JSONB columns rather than normalized into child tables (sql/schema-core.sql
 * has the full rationale).
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = [
  'date', 'client_name', 'client_id', 'service_id', 'service_name', 'job_type',
  'amount', 'tip', 'expense', 'count', 'notes', 'net_amount',
  'stage_order', 'stage', 'complete', 'invoice_id', 'quote_doc_id', 'package_id',
  'sub_tasks', 'milestones', 'time_entries', 'timer_started_at',
];

export default createResourceHandler('jobs', FIELDS);
export const config = { runtime: 'edge' };
