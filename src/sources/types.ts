import type {
  CollectionResult,
  CollectContext,
  ConnectorPreview,
  NormalizedItem,
  PlatformType,
} from "@/connectors/types";
import type { SourceProviderId } from "./ids";

export type { SourceProviderId } from "./ids";

export interface SourceProviderDescriptor {
  id: SourceProviderId;
  platform: PlatformType;
  label: string;
  kind: "api" | "subscription" | "rule" | "sidecar";
  supportsPreview: boolean;
}

/**
 * Uniform boundary between monitor configuration and content ingestion.
 * Provider adapters own platform-specific casts; the worker and API routes only
 * speak this contract.
 */
export interface SourceProvider {
  descriptor: SourceProviderDescriptor;
  collect(
    config: Record<string, unknown>,
    cursor: Record<string, unknown>,
    context?: CollectContext,
  ): Promise<CollectionResult>;
  validate?(config: Record<string, unknown>): Promise<ConnectorPreview>;
}

export function stampItemsWithProvider(
  providerId: SourceProviderId,
  items: NormalizedItem[],
): NormalizedItem[] {
  return items.map((item) => ({
    ...item,
    sourceProvider: item.sourceProvider ?? providerId,
  }));
}

export async function collectFromProvider(
  provider: SourceProvider,
  config: Record<string, unknown>,
  cursor: Record<string, unknown>,
  context?: CollectContext,
): Promise<CollectionResult> {
  const result = await provider.collect(config, cursor, context);
  return {
    ...result,
    items: stampItemsWithProvider(provider.descriptor.id, result.items),
  };
}

export async function validateWithProvider(
  provider: SourceProvider,
  config: Record<string, unknown>,
): Promise<ConnectorPreview> {
  if (!provider.validate) throw new Error(`SOURCE_PREVIEW_UNSUPPORTED:${provider.descriptor.id}`);
  const preview = await provider.validate(config);
  return {
    ...preview,
    items: stampItemsWithProvider(provider.descriptor.id, preview.items),
  };
}
