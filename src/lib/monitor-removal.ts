export interface MonitorRemovalOptions {
  cancelWerss: boolean;
  deleteItems: boolean;
}

export function parseMonitorRemovalOptions(url: string): MonitorRemovalOptions {
  const params = new URL(url).searchParams;
  return {
    cancelWerss: params.get("cancelWerss") === "1",
    deleteItems: params.get("deleteItems") === "1",
  };
}

export function archiveMonitorConfig(
  config: Record<string, unknown> | null,
  archivedAt: Date,
): Record<string, unknown> {
  return { ...(config ?? {}), _archivedAt: archivedAt.toISOString() };
}
