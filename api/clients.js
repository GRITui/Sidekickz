/* Sidekick — api/clients.js
 *
 * Phase 1 of the local-first -> backend migration: the one representative
 * data resource proving the auth + CRUD + row-scoping pattern end-to-end
 * before it's fanned out to the other 13 IndexedDB stores (see the project
 * plan). GET (list) / POST (create) / PUT+DELETE (via ?cuid=) — see
 * lib/crudHandler.js for what every verb actually does.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = ['name', 'phone', 'email', 'tags', 'notes', 'tax_id', 'billing_address', 'member_no'];

export default createResourceHandler('clients', FIELDS);
export const config = { runtime: 'edge' };
