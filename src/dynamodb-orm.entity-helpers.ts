import { getEntityMetadata, getHooksMetadata } from './dynamodb-orm.metadata-store';
import { InvalidEntityError, ValidationError } from './dynamodb-orm.errors';
import { EntityTarget } from './dynamodb-orm-decorators/entity.decorators';

/**
 * Deep-clones a default value safely. Recognises Date, Buffer/Uint8Array,
 * Map and Set; everything else goes through `structuredClone` (Node 18+).
 * Class instances do NOT preserve their prototype — use a factory function
 * (`{ default: () => new MyClass() }`) when you need that.
 */
function cloneDefault(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof Set) return new Set(Array.from(value, cloneDefault));
  if (value instanceof Map) {
    return new Map(
      Array.from(value, ([k, v]) => [cloneDefault(k), cloneDefault(v)]),
    );
  }
  return structuredClone(value);
}

export class EntityHelpers<T> {
  constructor(private readonly entityClass: EntityTarget<T>) {}

  /**
   * Instantiates the entity class and merges the supplied partial into it.
   * Centralises the `Object.assign(new EntityClass(), partial)` incantation
   * used by `create`, `update` and `batchWrite`.
   */
  instantiate(partial: Partial<T>): T {
    return Object.assign(new this.entityClass() as object, partial) as T;
  }

  applyDefaults(entity: T): T {
    const metadata = getEntityMetadata(this.entityClass);
    if (metadata && metadata.attributes) {
      const record = entity as Record<string, unknown>;
      for (const [key, attr] of Object.entries(metadata.attributes)) {
        if (attr.default !== undefined && record[key] === undefined) {
          if (typeof attr.default === 'function') {
            record[key] = (attr.default as () => unknown)();
          } else {
            record[key] = cloneDefault(attr.default);
          }
        }
      }
    }
    return entity;
  }

  parseDynamoItem(rawItem: Record<string, unknown>): T {
    const filteredItem = this.filterHiddenAttributes(rawItem);
    const metadata = getEntityMetadata(this.entityClass);

    for (const [key, attr] of Object.entries(metadata.attributes)) {
      if (attr.type !== 'date') continue;
      const raw = filteredItem[key];
      if (raw === undefined || raw === null || raw instanceof Date) continue;
      if (typeof raw === 'string' || typeof raw === 'number') {
        filteredItem[key] = new Date(raw);
      }
    }

    return Object.assign(new this.entityClass() as object, filteredItem) as T;
  }

  async applyHooks(
    entity: T,
    hookType: keyof ReturnType<typeof getHooksMetadata>
  ): Promise<void> {
    const hooks = getHooksMetadata(this.entityClass);
    const entityRecord = entity as Record<string, unknown>;
    for (const hook of hooks[hookType] || []) {
      if (typeof entityRecord[hook] === 'function') {
        await (entityRecord[hook] as () => Promise<void> | void)();
      }
    }
  }

  /**
   * Validates that no attribute marked `nullable: false` is null/undefined.
   * @param entity - the entity instance to validate
   * @param presentFields - optional set of field names being written. When
   *   provided, only those fields are validated. Used by `update()` to
   *   enforce nullability only on fields actually included in the partial.
   */
  validateNonNullable(entity: T, presentFields?: Iterable<string>): void {
    const metadata = getEntityMetadata(this.entityClass);
    if (!metadata?.attributes) return;

    const whitelist = presentFields ? new Set(presentFields) : undefined;

    for (const [key, attr] of Object.entries(metadata.attributes)) {
      if (attr.nullable !== false) continue;
      if (whitelist && !whitelist.has(key)) continue;
      const value = (entity as Record<string, unknown>)[key];
      if (value === null || value === undefined) {
        const entityName = this.entityClass.name;
        throw new InvalidEntityError(
          `Field '${key}' in ${entityName} cannot be null or undefined`,
          { entity: entityName, field: key },
        );
      }
    }
  }

  convertToPlainObject(entity: T): Record<string, unknown> {
    const plainObject: Record<string, unknown> = {};
    const entityRecord = entity as Record<string | symbol, unknown>;
    const keys = [
      ...Object.keys(entityRecord),
      ...Object.getOwnPropertySymbols(entityRecord),
    ];

    const ancestors = new WeakSet<object>();

    for (const key of keys) {
      const keyName = typeof key === 'symbol' ? key.description : key;
      if (keyName === undefined) continue;
      const value = entityRecord[key];
      plainObject[keyName] = this.serializeValue(value, ancestors);
    }

    return plainObject;
  }

  private serializeValue(value: unknown, ancestors: WeakSet<object>): unknown {
    if (value === undefined || value === null) return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Set || value instanceof Map) return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
    if (typeof value !== 'object') return value;

    // Cycle detection via "ancestors in current recursion path" — NOT
    // "everything ever visited". Two sibling fields that share a non-cyclic
    // reference must serialize fine; only true cycles (a → … → a) throw.
    if (ancestors.has(value as object)) {
      throw new ValidationError(
        `Circular reference detected while serializing entity ${this.entityClass.name}`,
        { entity: this.entityClass.name },
      );
    }
    ancestors.add(value as object);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.serializeValue(item, ancestors));
      }
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.serializeValue(v, ancestors);
      }
      return result;
    } finally {
      ancestors.delete(value as object);
    }
  }

  private filterHiddenAttributes(
    data: Record<string, unknown>
  ): Record<string, unknown> {
    const attributesMetadata = getEntityMetadata(this.entityClass).attributes || {};
    const filteredData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (!attributesMetadata[key]?.hidden) {
        filteredData[key] = value;
      }
    }

    return filteredData;
  }
}
