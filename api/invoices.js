/* Sidekick — api/invoices.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `invoices` IndexedDB store. lineItems and the issue-time paymentChannels
 * snapshot are embedded arrays on the invoice record in the client today —
 * mirrored here as JSONB columns (sql/schema-core.sql has the rationale).
 *
 * Not to be confused with app/invoices.js (the client-side module) — this
 * is the API-layer counterpart, a different file in a different directory.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = [
  'number', 'issue_date', 'due_date', 'client_id', 'client_name', 'client_tax_id',
  'client_address', 'line_items', 'subtotal', 'wht_pct', 'vat_pct', 'vat', 'wht',
  'client_pays', 'you_receive', 'deposit_pct', 'status', 'payment_channels', 'notes',
];

export default createResourceHandler('invoices', FIELDS);
export const config = { runtime: 'edge' };
