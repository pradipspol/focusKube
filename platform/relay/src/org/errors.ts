/** Thrown by org/billing.ts and org/routes.ts for a user-facing, status-coded failure —
 * caught at the route boundary and turned into `res.status(status).json({ error: message })`,
 * the same shape every other route in this service already returns errors in. */
export class OrgActionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
