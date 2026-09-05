/**
 * Identifies exactly which signed-in account/tenant/subscription/context a single
 * az/kube/helm/kubectl call is operating against. Threaded through every CLI exec
 * (`util/run.ts`) and every kube auth/context resolution (`kube/authGuard.ts`) so a
 * cross-account leak shows up immediately in the logs instead of silently mixing data.
 */
export interface CallIdentity {
  userId?: string;
  scope?: string;
  context?: string;
  accountId?: string;
  accountEmail?: string;
  tenantId?: string;
  tenantName?: string;
  subscriptionId?: string;
  subscriptionName?: string;
  resourceGroup?: string;
  clusterName?: string;
}
