/**
 * Whether a kubeconfig user entry authenticates via an Azure-backed exec plugin
 * (kubelogin, or the `az` CLI directly) rather than a static credential
 * (cert/token/basic auth). Shared by authGuard.ts (gates actual kube API calls)
 * and the contexts listing (gates the "sign in to Azure" UI prompt) so both
 * agree on exactly which contexts actually need an Azure session.
 */
export function userRequiresAzureAuth(user: { exec?: any; authProvider?: any } | null | undefined): boolean {
  const userAny = user as any;
  const exec = userAny?.exec ?? userAny?.authProvider?.config?.exec ?? userAny?.authProvider?.exec;
  const command = String(exec?.command ?? '').toLowerCase();
  return !!exec && (command.includes('kubelogin') || command.includes('az'));
}
