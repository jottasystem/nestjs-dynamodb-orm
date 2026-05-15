import {
  DynamoDBDocumentClient,
  TranslateConfig,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { EntityMetadata } from './dynamodb-orm.metadata-store';

export interface DocumentClientFactoryOptions {
  /** Per-client AWS SDK config (endpoint, credentials, requestHandler, …). Region is taken from the entity's table ARN if not provided. */
  clientConfig?: DynamoDBClientConfig;
  /** `@aws-sdk/lib-dynamodb` marshall/unmarshall overrides. */
  translateConfig?: TranslateConfig;
  /**
   * Provide a fully constructed `DynamoDBDocumentClient` — bypasses the
   * internal factory entirely. The lib does NOT apply its safe marshall
   * defaults (`removeUndefinedValues`, `convertEmptyValues: false`) when
   * you take this path; configure them on the client you pass in.
   */
  client?: DynamoDBDocumentClient;
}

const DEFAULT_TRANSLATE: TranslateConfig = {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
};

const clientCache = new Map<string, DynamoDBDocumentClient>();

/**
 * Resolves a `DynamoDBDocumentClient` for the given entity.
 *
 * Strategy:
 * 1. If `options.client` is set, return it as-is (no caching).
 * 2. If `options.clientConfig` is set, build a fresh client every time —
 *    custom configs (credentials, endpoints, requestHandler) MUST NOT be
 *    cached because two configs that serialise to the same key can still
 *    point to different AWS accounts.
 * 3. Otherwise (the common case: default AWS credentials chain), reuse a
 *    cached client keyed by region.
 */
export function createDocumentClient(
  metadata: EntityMetadata,
  options?: DocumentClientFactoryOptions,
): DynamoDBDocumentClient {
  if (options?.client) {
    return options.client;
  }

  const translate = mergeTranslateConfig(options?.translateConfig);
  // `{ region: undefined }` is not a real customisation — only treat it
  // as a custom config if at least one value is defined.
  const hasCustomConfig =
    !!options?.clientConfig &&
    Object.values(options.clientConfig).some((v) => v !== undefined);

  if (hasCustomConfig) {
    return DynamoDBDocumentClient.from(
      new DynamoDBClient({
        ...(options!.clientConfig as DynamoDBClientConfig),
        region: options!.clientConfig!.region ?? metadata.region,
      }),
      translate,
    );
  }

  const region = metadata.region;
  const cached = clientCache.get(region);
  if (cached) return cached;

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region }),
    translate,
  );
  clientCache.set(region, client);
  return client;
}

function mergeTranslateConfig(custom?: TranslateConfig): TranslateConfig {
  if (!custom) return DEFAULT_TRANSLATE;
  return {
    marshallOptions: {
      ...DEFAULT_TRANSLATE.marshallOptions,
      ...custom.marshallOptions,
    },
    unmarshallOptions: {
      ...DEFAULT_TRANSLATE.unmarshallOptions,
      ...custom.unmarshallOptions,
    },
  };
}

/**
 * Clears the client cache. Intended for testing only.
 * @internal
 */
export function clearDocumentClientCache(): void {
  clientCache.clear();
}
