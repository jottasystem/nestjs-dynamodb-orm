export type {
  EntityMetadata,
  AttributeMetadata,
  HooksMetadata,
} from './dynamodb-orm.metadata-store';

export type { EntityMetadata as TableMetadata } from './dynamodb-orm.metadata-store';

export type BinaryType = Buffer | Uint8Array | string;

export type DynamoKeyType = string | number | BinaryType;

/**
 * Filter conditions per attribute. Generic over the attribute's TypeScript
 * type when used through `EntityFilters<T>` (preferred), which gives full
 * type inference on `equals`, `in`, etc.
 *
 * The non-generic form (`QueryFilters` with default `unknown`) stays
 * available for dynamic filter construction.
 */
export interface QueryFilters<V = unknown> {
  equals?: V;
  notEquals?: V;
  exists?: boolean;
  beginsWith?: string;
  between?: [V, V];
  greaterThan?: V;
  greaterThanOrEqual?: V;
  lessThan?: V;
  lessThanOrEqual?: V;
  contains?: V | V[];
  in?: V[];
  notIn?: V[];
}

/**
 * Per-entity filter map: each attribute key infers its own value type from `T`.
 *
 * @example
 * type ProductFilters = EntityFilters<Product>;
 * const f: ProductFilters = { archived: { equals: false }, tags: { contains: ['x'] } };
 */
export type EntityFilters<T> = {
  [K in keyof T]?: QueryFilters<T[K]>;
};

/**
 * Filter map accepted by `find`, `scan` and `count`. Either a typed
 * `EntityFilters<T>` (preferred, per-attribute inference) or a loose
 * `Record<string, QueryFilters>` for dynamic construction.
 */
export type FiltersInput<T> = EntityFilters<T> | Record<string, QueryFilters>;

export type SortKeyCondition =
  | { equals: DynamoKeyType }
  | { beginsWith: string }
  | { between: [DynamoKeyType, DynamoKeyType] }
  | { greaterThan: DynamoKeyType }
  | { lessThan: DynamoKeyType }
  | { greaterThanOrEqual: DynamoKeyType }
  | { lessThanOrEqual: DynamoKeyType };

export interface QueryOptions<T = unknown> {
  indexName?: string;
  sortKeyCondition?: SortKeyCondition;
  filters?: FiltersInput<T>;
  limit?: number;
  maxScanned?: number;
  exclusiveStartKey?: Record<string, unknown>;
  select?: string[];
  descending?: boolean;
}

export interface CreateOptions {
  ensureNew?: boolean;
}

export interface UpdateOptions {
  ensureExists?: boolean;
  nullHandling?: 'persist' | 'remove';
  conditionExpression?: string;
  conditionExpressionValues?: Record<string, unknown>;
  conditionExpressionNames?: Record<string, string>;
  /** Override the default `ALL_NEW`. Set to `'NONE'` to save capacity. */
  returnValues?: 'ALL_NEW' | 'UPDATED_NEW' | 'ALL_OLD' | 'UPDATED_OLD' | 'NONE';
}

export interface ScanOptions<T = unknown> {
  indexName?: string;
  filters?: FiltersInput<T>;
  select?: string[];
  limit?: number;
  maxScanned?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

export interface CountOptions<T = unknown> {
  indexName?: string;
  sortKeyCondition?: SortKeyCondition;
  filters?: FiltersInput<T>;
  maxScanned?: number;
}

export interface BatchWriteInput<T> {
  puts?: Partial<T>[];
  deletes?: Array<{ partitionKey: DynamoKeyType; sortKey?: DynamoKeyType }>;
}

export interface BatchGetResult<T> {
  items: T[];
  missingKeys: Array<{ partitionKey: DynamoKeyType; sortKey?: DynamoKeyType }>;
}

export interface RepositoryOptions {
  verbose?: boolean;
  maxRetries?: number;
  /** Override default page size for internal pagination. Capped at 1MB by DynamoDB anyway. */
  pageSize?: number;
}

/**
 * Minimal logger interface for dependency injection.
 * Any object with these three methods will satisfy the contract — the
 * built-in `Logger` from `@nestjs/common` works out of the box.
 */
export interface LoggerInterface {
  debug(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}
