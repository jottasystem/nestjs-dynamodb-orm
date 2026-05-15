import { Inject } from '@nestjs/common';
import {
  ensureEntityMetadata,
  ensureHookMetadata,
  generateRepositoryToken,
  parseTableArn,
} from '../dynamodb-orm.metadata-store';

/**
 * Represents a class constructor that produces instances of type T.
 */
export type EntityTarget<T = unknown> = (new (...args: unknown[]) => T) & { name: string };

export { generateRepositoryToken };

/**
 * Parameter decorator that injects the per-entity repository.
 *
 * @example
 * constructor(@InjectRepository(Product) private repo: DynamoDBOrmRepository<Product>) {}
 */
export function InjectRepository<T>(
  entity: EntityTarget<T>
): ParameterDecorator {
  return Inject(generateRepositoryToken(entity));
}

/**
 * Declares a class as a DynamoDB-backed entity bound to a table ARN.
 * See README "Quick start" for a full example.
 *
 * @param tableArn - Full DynamoDB table ARN: `arn:aws:dynamodb:<region>:<account>:table/<name>`
 * @throws Error if `tableArn` is missing or malformed.
 */
export function Table(tableArn: string): ClassDecorator {
  return (target) => {
    if (!tableArn) {
      throw new Error(
        `[Table] ARN is required for entity ${target.name}. Provide it via env var, e.g. PRODUCT__ENTITY_NAME__DYNAMODB_TABLE_ARN`
      );
    }

    if (!tableArn.startsWith('arn:aws:dynamodb:')) {
      throw new Error(
        `[Table] Invalid DynamoDB table ARN format for entity ${target.name}: ${tableArn}`
      );
    }

    const metadata = ensureEntityMetadata(target);
    metadata.tableArn = tableArn;

    const { tableName, region } = parseTableArn(tableArn);
    metadata.tableName = tableName;
    metadata.region = region;
  };
}

/** Marks the property as the table's partition key. */
export function PartitionKey(): PropertyDecorator {
  return (target, propertyKey) => {
    const metadata = ensureEntityMetadata(target.constructor);
    metadata.keys.partitionKey = propertyKey.toString();
  };
}

/** Marks the property as the table's sort key. */
export function SortKey(): PropertyDecorator {
  return (target, propertyKey) => {
    const metadata = ensureEntityMetadata(target.constructor);
    metadata.keys.sortKey = propertyKey.toString();
  };
}

/**
 * Marks the property as a DynamoDB attribute.
 *
 * @param options.hidden - exclude the attribute from loaded entities (`findOne`, `find`, `scan`)
 * @param options.default - default value applied on `create` when the field is undefined.
 *   Use a factory (`() => new Date()`) for class instances; primitives, plain objects/arrays,
 *   Date, Buffer, Map and Set are deep-cloned automatically. Class instances passed directly
 *   are deep-cloned but lose their prototype — use a factory.
 * @param options.nullable - when `false`, `create()` rejects null/undefined values; `update()`
 *   only enforces this on fields included in the partial.
 * @param options.type - `'date'` parses incoming strings/numbers into `Date` on load and
 *   serialises `Date` instances to ISO strings on write.
 *
 * Stacks merge: calling `@Attribute()` twice (or in combination with `@Index`) preserves
 * options from previous calls.
 */
export function Attribute(options?: {
  hidden?: boolean;
  default?: unknown;
  nullable?: boolean;
  type?: 'date';
}): PropertyDecorator {
  return (target, propertyKey) => {
    const metadata = ensureEntityMetadata(target.constructor);
    const key = propertyKey.toString();
    metadata.attributes[key] = { ...(metadata.attributes[key] ?? {}), ...(options ?? {}) };
  };
}

/**
 * Declares a Global (GSI) or Local (LSI) Secondary Index on this attribute.
 *
 * @param config.type - `'GSI'` requires `partitionKey`; `'LSI'` shares the table's partition key.
 * @param config.name - defaults to `${type}_${propertyKey}` if omitted.
 * @param config.sortKeyType - DynamoDB sort-key scalar type; only used when the lib provisions tables.
 *
 * Idempotent on the same property: re-declaring the same index name is a no-op (no duplicates).
 */
export function Index(config: {
  type: 'GSI' | 'LSI';
  partitionKey?: string;
  sortKey?: string;
  name?: string;
  sortKeyType?: 'S' | 'N' | 'B';
  projectionType?: 'ALL' | 'KEYS_ONLY' | 'INCLUDE';
  nonKeyAttributes?: string[];
}): PropertyDecorator {
  return (target, propertyKey) => {
    const metadata = ensureEntityMetadata(target.constructor);

    const attribute = propertyKey as string;
    const name = config.name ?? `${config.type}_${attribute}`;

    if (config.type === 'GSI' && !config.partitionKey) {
      throw new Error(`[Index] GSI '${name}' requires a partitionKey.`);
    }

    // For LSI, the decorated property IS the sort key (DynamoDB LSIs always
    // share the table's partition key + a custom sort attribute). For GSI,
    // an explicit `sortKey` is optional.
    const sortKey =
      config.sortKey ?? (config.type === 'LSI' ? attribute : undefined);

    const exists = metadata.indexes.some(
      (idx) => idx.name === name && idx.attribute === attribute,
    );
    if (!exists) {
      metadata.indexes.push({
        ...config,
        attribute,
        name,
        sortKey,
      });
    }

    if (!metadata.attributes[attribute]) {
      metadata.attributes[attribute] = {};
    }
  };
}

/** Method runs once before an item is inserted via `create()` or `batchWrite()`. */
export function BeforeInsert(): MethodDecorator {
  return (target, propertyKey) => {
    ensureHookMetadata(target.constructor).beforeInsert.push(propertyKey as string);
  };
}

/** Method runs once before an item is updated via `update()`. */
export function BeforeUpdate(): MethodDecorator {
  return (target, propertyKey) => {
    ensureHookMetadata(target.constructor).beforeUpdate.push(propertyKey as string);
  };
}

/** Method runs once after a successful `create()` (and per-item in `batchWrite()`). */
export function AfterInsert(): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    ensureHookMetadata(target.constructor).afterInsert.push(propertyKey as string);
    return descriptor;
  };
}

/** Method runs once after a successful `update()`. */
export function AfterUpdate(): MethodDecorator {
  return (target, propertyKey) => {
    ensureHookMetadata(target.constructor).afterUpdate.push(propertyKey as string);
  };
}

/** Method runs after an item is loaded via `findOne()`, `find()`, `scan()` or `batchGet()`. */
export function AfterLoad(): MethodDecorator {
  return (target, propertyKey) => {
    ensureHookMetadata(target.constructor).afterLoad.push(propertyKey as string);
  };
}
