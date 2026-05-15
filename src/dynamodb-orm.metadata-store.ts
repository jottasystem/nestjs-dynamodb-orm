import { MetadataError } from './dynamodb-orm.errors';

export interface AttributeMetadata {
  hidden?: boolean;
  default?: unknown;
  nullable?: boolean;
  type?: 'date';
}

export interface EntityMetadata {
  attributes: Record<string, AttributeMetadata>;
  keys: {
    partitionKey: string;
    sortKey?: string;
  };
  indexes: Array<{
    type: 'GSI' | 'LSI';
    partitionKey?: string;
    sortKey?: string;
    name: string;
    attribute: string;
    sortKeyType?: 'S' | 'N' | 'B';
    projectionType?: 'ALL' | 'KEYS_ONLY' | 'INCLUDE';
    nonKeyAttributes?: string[];
  }>;
  tableName: string;
  tableArn: string;
  region: string;
}

export interface HooksMetadata {
  beforeInsert: string[];
  beforeUpdate: string[];
  afterInsert: string[];
  afterUpdate: string[];
  afterLoad: string[];
}

// --- Internal storage (not directly exported) ---

const entityMetadataByConstructor = new WeakMap<object, EntityMetadata>();
const hooksMetadataByConstructor = new WeakMap<object, HooksMetadata>();

// Identity-based token registry
const tokenRegistry = new WeakMap<object, string>();
let tokenCounter = 0;

// --- Factory helpers ---

function createEmptyMetadata(): EntityMetadata {
  return {
    attributes: {},
    keys: { partitionKey: '' },
    indexes: [],
    tableName: '',
    tableArn: '',
    region: '',
  };
}

function createEmptyHooks(): HooksMetadata {
  return {
    beforeInsert: [],
    beforeUpdate: [],
    afterInsert: [],
    afterUpdate: [],
    afterLoad: [],
  };
}

// --- Public accessors ---

/**
 * Retrieves entity metadata for a given constructor.
 * Throws MetadataError if no metadata is registered.
 */
export function getEntityMetadata(entity: object & { name: string }): EntityMetadata {
  const metadata = entityMetadataByConstructor.get(entity);
  if (!metadata) {
    throw new MetadataError(
      `No metadata registered for entity '${entity.name}'. Did you forget @Table()?`,
      { entity: entity.name },
    );
  }
  return metadata;
}

/**
 * Retrieves hooks metadata for a given constructor.
 * Returns safe defaults when no hooks are registered.
 */
export function getHooksMetadata(entity: object & { name: string }): HooksMetadata {
  return hooksMetadataByConstructor.get(entity) ?? createEmptyHooks();
}

/**
 * Ensures entity metadata exists for the given constructor.
 */
export function ensureEntityMetadata(entity: object & { name: string }): EntityMetadata {
  let metadata = entityMetadataByConstructor.get(entity);
  if (!metadata) {
    metadata = createEmptyMetadata();
    entityMetadataByConstructor.set(entity, metadata);
  }
  return metadata;
}

/**
 * Ensures hooks metadata exists for the given constructor.
 */
export function ensureHookMetadata(entity: object & { name: string }): HooksMetadata {
  let hooks = hooksMetadataByConstructor.get(entity);
  if (!hooks) {
    hooks = createEmptyHooks();
    hooksMetadataByConstructor.set(entity, hooks);
  }
  return hooks;
}

/**
 * Parses a DynamoDB table ARN into its components.
 * @returns The parsed table name and region
 * @throws Error if ARN format is invalid
 */
export function parseTableArn(tableArn: string): { tableName: string; region: string } {
  const tableNameMatch = tableArn.match(/table\/([^/]+)$/);
  if (!tableNameMatch) {
    throw new Error(`Invalid table name in ARN: ${tableArn}`);
  }

  const [, , , region] = tableArn.split(':');
  if (!region) {
    throw new Error(`Invalid region in ARN: ${tableArn}`);
  }

  return { tableName: tableNameMatch[1], region };
}

/**
 * Generates a stable, identity-based repository injection token for an entity constructor.
 * Uses a WeakMap + counter to ensure each constructor gets a unique, stable token.
 */
export function generateRepositoryToken(entity: object & { name: string }): string {
  if (!tokenRegistry.has(entity)) {
    tokenRegistry.set(
      entity,
      `DYNAMODB_ORM_REPOSITORY_${tokenCounter++}_${entity.name}`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return tokenRegistry.get(entity)!;
}
