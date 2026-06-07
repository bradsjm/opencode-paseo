/**
 * Builds the stable inbox event ID used for hydrated permission requests.
 *
 * @param permissionId - The permission request identifier.
 * @returns The deterministic hydration inbox event ID.
 */
export function getHydrationPermissionEventId(permissionId: string): string {
  return `hydration-permission-${permissionId}`
}
