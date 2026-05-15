import { getEntityMetadata } from './dynamodb-orm.metadata-store';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  PutCommandInput,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  UpdateCommandInput,
  DeleteCommand,
  BatchGetCommand,
  BatchWriteCommand,
  TransactWriteCommand,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { Logger } from '@nestjs/common';
import {
  BinaryType,
  QueryOptions,
  ScanOptions,
  CreateOptions,
  UpdateOptions,
  CountOptions,
  SortKeyCondition,
  TableMetadata,
  DynamoKeyType,
  LoggerInterface,
  RepositoryOptions,
  BatchGetResult,
  BatchWriteInput,
} from './dynamodb-orm.types';
import {
  DynamoDBOrmError,
  MetadataError,
  ValidationError,
  ConditionFailedError,
  ThroughputExceededError,
  EntityNotFoundError,
} from './dynamodb-orm.errors';
import { FilterBuilder } from './dynamodb-orm.filter-builder';
import { EntityHelpers } from './dynamodb-orm.entity-helpers';
import { EntityTarget } from './dynamodb-orm-decorators/entity.decorators';

const KEY_PLACEHOLDERS = {
  PARTITION_KEY: '#pk',
  SORT_KEY: '#sk',
} as const;

/** DynamoDB BatchGetItem hard limit: 100 keys per request. */
const BATCH_GET_CHUNK_SIZE = 100;

/** DynamoDB BatchWriteItem hard limit: 25 ops per request. */
const BATCH_WRITE_CHUNK_SIZE = 25;

/** DynamoDB TransactWriteItems hard limit: 100 ops per transaction. */
const TRANSACT_WRITE_MAX_OPS = 100;

/** Base delay for exponential-backoff retry (ms). */
const RETRY_BASE_DELAY_MS = 100;

/** Default retry budget for batch operations. */
const DEFAULT_MAX_RETRIES = 3;

interface ResolvedIndex {
  partitionKey: string;
  sortKey?: string;
  type: 'TABLE' | 'GSI' | 'LSI';
}

function isMissingKey(value: unknown): boolean {
  return value === undefined || value === null;
}

export class DynamoDBOrmRepository<T> {
  private readonly metadata: TableMetadata;
  private readonly logger: LoggerInterface;
  private readonly filterBuilder: FilterBuilder;
  private readonly entityHelpers: EntityHelpers<T>;

  constructor(
    private readonly entity: EntityTarget<T>,
    private readonly documentClient: DynamoDBDocumentClient,
    private readonly options: RepositoryOptions = {},
    logger?: LoggerInterface,
  ) {
    this.metadata = getEntityMetadata(this.entity);
    this.logger = logger ?? new Logger(`DynamoDBOrm:${this.entity.name}`);
    this.filterBuilder = new FilterBuilder(this.metadata);
    this.entityHelpers = new EntityHelpers(this.entity);

    if (!this.metadata.tableArn) {
      throw new MetadataError(
        `No 'tableArn' defined for entity ${this.entity.name}. Did you forget @Table()?`,
        { entity: this.entity.name },
      );
    }
  }

  private log(message: string, data?: unknown): void {
    if (this.options.verbose) {
      this.logger.debug(message, data);
    }
  }

  /**
   * Query items by partition key with optional sort key conditions and filters.
   *
   * Note: DynamoDB applies `Limit` BEFORE `FilterExpression`. The ORM paginates
   * internally to return up to `limit` post-filter items. Use `maxScanned` to
   * cap the total number of items scanned across pages.
   */
  async find(
    partitionKey: DynamoKeyType,
    options?: QueryOptions<T>,
  ): Promise<{ items: T[]; lastEvaluatedKey: Record<string, unknown> | null }> {
    return this.paginate(
      (opts) => this.executeSingleQuery(partitionKey, opts),
      options,
      'find() called without limit or maxScanned — this may scan the entire partition',
    );
  }

  private async executeSingleQuery(
    partitionKey: DynamoKeyType,
    options?: QueryOptions<T>,
  ): Promise<{
    items: T[];
    lastEvaluatedKey: Record<string, unknown> | null;
    scannedCount: number;
  }> {
    const queryParams = this.buildQueryParams(partitionKey, options);
    this.log('Query Params:', queryParams);

    const result = await this.wrapSdkCall('find', () =>
      this.documentClient.send(new QueryCommand(queryParams)),
    );

    this.log('Query Result:', {
      Count: result.Count,
      ScannedCount: result.ScannedCount,
      Items: result.Items?.length,
    });

    const items = await Promise.all(
      (result.Items ?? []).map(async (raw) => {
        const entity = this.entityHelpers.parseDynamoItem(raw);
        await this.entityHelpers.applyHooks(entity, 'afterLoad');
        return entity;
      }),
    );

    return {
      items,
      lastEvaluatedKey: (result.LastEvaluatedKey as Record<string, unknown>) ?? null,
      scannedCount: result.ScannedCount ?? 0,
    };
  }

  /**
   * Scan the entire table with optional filters.
   *
   * Note: DynamoDB applies `Limit` BEFORE `FilterExpression`. The ORM paginates
   * internally to return up to `limit` post-filter items. Use `maxScanned` to
   * cap the total number of items scanned across pages.
   */
  async scan(options?: ScanOptions<T>): Promise<{
    items: T[];
    lastEvaluatedKey: Record<string, unknown> | null;
  }> {
    return this.paginate(
      (opts) => this.executeSingleScan(opts),
      options,
      'scan() called without limit or maxScanned — this may scan the entire table',
    );
  }

  private async executeSingleScan(options?: ScanOptions<T>): Promise<{
    items: T[];
    lastEvaluatedKey: Record<string, unknown> | null;
    scannedCount: number;
  }> {
    const scanParams = this.buildScanParams(options);
    this.log('Scan Params:', scanParams);

    const result = await this.wrapSdkCall('scan', () =>
      this.documentClient.send(new ScanCommand(scanParams)),
    );

    const items = await Promise.all(
      (result.Items ?? []).map(async (raw) => {
        const entity = this.entityHelpers.parseDynamoItem(raw);
        await this.entityHelpers.applyHooks(entity, 'afterLoad');
        return entity;
      }),
    );

    return {
      items,
      lastEvaluatedKey: (result.LastEvaluatedKey as Record<string, unknown>) ?? null,
      scannedCount: result.ScannedCount ?? 0,
    };
  }

  async findOne(
    partitionKey: DynamoKeyType,
    sortKey?: DynamoKeyType,
  ): Promise<T | null> {
    const key = this.buildItemKey(partitionKey, sortKey);

    const result = await this.wrapSdkCall('findOne', () =>
      this.documentClient.send(
        new GetCommand({
          TableName: this.metadata.tableName,
          Key: key,
        }),
      ),
    );

    if (!result.Item) return null;

    const entity = this.entityHelpers.parseDynamoItem(result.Item);
    await this.entityHelpers.applyHooks(entity, 'afterLoad');
    return entity;
  }

  /**
   * Returns `true` if an item exists for the given keys, `false` otherwise.
   * Uses `GetItem` with `ProjectionExpression` to avoid loading the full item.
   */
  async exists(
    partitionKey: DynamoKeyType,
    sortKey?: DynamoKeyType,
  ): Promise<boolean> {
    const key = this.buildItemKey(partitionKey, sortKey);
    const result = await this.wrapSdkCall('exists', () =>
      this.documentClient.send(
        new GetCommand({
          TableName: this.metadata.tableName,
          Key: key,
          ProjectionExpression: '#pk_exists',
          ExpressionAttributeNames: { '#pk_exists': this.metadata.keys.partitionKey },
        }),
      ),
    );
    return !!result.Item;
  }

  /**
   * Returns the count of items matching the partition key + optional filters
   * without materialising entities. Uses `Select: 'COUNT'`. Paginates internally.
   */
  async count(
    partitionKey: DynamoKeyType,
    options?: CountOptions<T>,
  ): Promise<number> {
    let total = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let scanned = 0;

    do {
      const params = this.buildQueryParams(partitionKey, {
        ...options,
        filters: options?.filters,
        exclusiveStartKey,
      });

      const result = await this.wrapSdkCall('count', () =>
        this.documentClient.send(
          new QueryCommand({ ...params, Select: 'COUNT' }),
        ),
      );

      total += result.Count ?? 0;
      scanned += result.ScannedCount ?? 0;
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;

      if (options?.maxScanned && scanned >= options.maxScanned) break;
    } while (exclusiveStartKey);

    return total;
  }

  /**
   * Create (put) an item in DynamoDB.
   *
   * Explicit `null` values are persisted as DynamoDB `NULL` type.
   * (The `nullHandling: 'remove' | 'persist'` option is `update()`-only —
   * `create()` always persists nulls.)
   *
   * @param item - The item to create
   * @param options - Optional. Set `ensureNew: true` to prevent overwriting existing items.
   */
  async create(item: Partial<T>, options?: CreateOptions): Promise<T> {
    const entity = this.entityHelpers.instantiate(item);
    this.entityHelpers.applyDefaults(entity);

    await this.entityHelpers.applyHooks(entity, 'beforeInsert');
    this.entityHelpers.validateNonNullable(entity);

    const marshalled = this.entityHelpers.convertToPlainObject(entity);

    const putParams: PutCommandInput = {
      TableName: this.metadata.tableName,
      Item: marshalled as PutCommandInput['Item'],
    };

    if (options?.ensureNew) {
      putParams.ConditionExpression = 'attribute_not_exists(#pk_cond)';
      putParams.ExpressionAttributeNames = { '#pk_cond': this.metadata.keys.partitionKey };
    }

    await this.wrapSdkCall('create', () =>
      this.documentClient.send(new PutCommand(putParams)),
    );

    await this.entityHelpers.applyHooks(entity, 'afterInsert');
    return entity as T;
  }

  /**
   * Update an existing item in DynamoDB.
   *
   * Partial-friendly: only the fields present in `item` are sent to DynamoDB,
   * and `nullable: false` is enforced only on those same fields. Fields
   * omitted from the partial are left untouched.
   *
   * By default, `null` values generate REMOVE clauses (attribute is deleted).
   * Set `nullHandling: 'persist'` to store null as DynamoDB NULL type instead.
   */
  async update(item: Partial<T>, options?: UpdateOptions): Promise<T> {
    const presentFields = new Set(Object.keys(item as Record<string, unknown>));

    // Build the working entity from a fresh instance merged with the partial.
    // We snapshot values BEFORE hooks run so we can detect what the hook
    // genuinely touched via value-diff (presence check would conflate
    // class-field initializers with hook mutations).
    const fresh = new this.entity() as object;
    const entity = Object.assign(fresh, item) as T;
    const preHook: Record<string, unknown> = { ...(entity as Record<string, unknown>) };

    await this.entityHelpers.applyHooks(entity, 'beforeUpdate');

    const post = entity as Record<string, unknown>;
    const hookTouched = Object.keys(post).filter(
      (k) =>
        !presentFields.has(k) &&
        post[k] !== undefined &&
        !Object.is(preHook[k], post[k]),
    );
    const fieldsAfterHooks = new Set([...presentFields, ...hookTouched]);
    this.entityHelpers.validateNonNullable(entity, fieldsAfterHooks);

    const updateParams = this.buildUpdateParams(entity, options, fieldsAfterHooks);

    const result = await this.wrapSdkCall('update', () =>
      this.documentClient.send(new UpdateCommand(updateParams)),
    );

    const updated = this.entityHelpers.parseDynamoItem(result.Attributes ?? {});
    await this.entityHelpers.applyHooks(updated, 'afterUpdate');

    return updated;
  }

  async delete(
    partitionKey: DynamoKeyType,
    sortKey?: DynamoKeyType,
  ): Promise<void> {
    const key = this.buildItemKey(partitionKey, sortKey);

    await this.wrapSdkCall('delete', () =>
      this.documentClient.send(
        new DeleteCommand({
          TableName: this.metadata.tableName,
          Key: key,
        }),
      ),
    );
  }

  /**
   * Batch-load multiple items by key. Returns both found items and the keys
   * that were not found (or could not be processed after retries).
   *
   * @returns `{ items, missingKeys }`. Order of `items` is NOT guaranteed —
   *   correlate by reading the entity's own partition/sort key properties.
   */
  async batchGet(
    keys: Array<{ partitionKey: DynamoKeyType; sortKey?: DynamoKeyType }>,
  ): Promise<BatchGetResult<T>> {
    const allItems: T[] = [];
    const missingKeys: Array<{ partitionKey: DynamoKeyType; sortKey?: DynamoKeyType }> = [];

    // Collision-resistant: `JSON.stringify([pk, sk])` cannot collide for any
    // pk/sk values, no matter what characters they contain.
    const keyOf = (k: { partitionKey: DynamoKeyType; sortKey?: DynamoKeyType }) =>
      JSON.stringify([k.partitionKey, k.sortKey ?? null]);

    for (let i = 0; i < keys.length; i += BATCH_GET_CHUNK_SIZE) {
      const chunk = keys.slice(i, i + BATCH_GET_CHUNK_SIZE);
      const remainingRequestKeys = new Map(
        chunk.map((k) => [keyOf(k), { ...k, marshalled: this.buildItemKey(k.partitionKey, k.sortKey) }]),
      );

      let retries = 0;
      while (remainingRequestKeys.size > 0 && retries <= this.maxRetries) {
        const requestKeys = Array.from(remainingRequestKeys.values()).map((v) => v.marshalled);
        const result = await this.wrapSdkCall('batchGet', () =>
          this.documentClient.send(
            new BatchGetCommand({
              RequestItems: {
                [this.metadata.tableName]: { Keys: requestKeys },
              },
            }),
          ),
        );

        const items = result.Responses?.[this.metadata.tableName] ?? [];
        for (const raw of items) {
          const entity = this.entityHelpers.parseDynamoItem(raw);
          await this.entityHelpers.applyHooks(entity, 'afterLoad');
          allItems.push(entity);

          const rawRecord = raw as Record<string, unknown>;
          const pk = rawRecord[this.metadata.keys.partitionKey] as DynamoKeyType;
          const sk = this.metadata.keys.sortKey
            ? (rawRecord[this.metadata.keys.sortKey] as DynamoKeyType)
            : undefined;
          remainingRequestKeys.delete(keyOf({ partitionKey: pk, sortKey: sk }));
        }

        const unprocessed = result.UnprocessedKeys?.[this.metadata.tableName]?.Keys ?? [];
        if (unprocessed.length === 0) {
          for (const k of remainingRequestKeys.values()) {
            missingKeys.push({ partitionKey: k.partitionKey, sortKey: k.sortKey });
          }
          remainingRequestKeys.clear();
          break;
        }

        retries++;
        if (retries <= this.maxRetries) {
          await this.delayWithJitter(retries);
        }
      }

      if (remainingRequestKeys.size > 0) {
        throw new DynamoDBOrmError(
          `batchGet failed to process ${remainingRequestKeys.size} keys after ${this.maxRetries} retries`,
          {
            entity: this.entity.name,
            operation: 'batchGet',
            unprocessedKeys: Array.from(remainingRequestKeys.values()).map((v) => ({
              partitionKey: v.partitionKey,
              sortKey: v.sortKey,
            })),
          },
        );
      }
    }

    return { items: allItems, missingKeys };
  }

  /**
   * Batch put and/or delete items in DynamoDB (max 25 ops per chunk, capped by
   * `BatchWriteItem`). Mirrors the per-item validation and hook flow of
   * `create()` / `delete()` — `beforeInsert`, `validateNonNullable` and
   * `afterInsert` all run per put item.
   *
   * Accepts either `{ puts, deletes }` or a legacy plain array of items
   * (treated as puts) for backwards convenience.
   */
  async batchWrite(input: BatchWriteInput<T> | Partial<T>[]): Promise<void> {
    const normalized: BatchWriteInput<T> = Array.isArray(input)
      ? { puts: input }
      : input;
    const puts = normalized.puts ?? [];
    const deletes = normalized.deletes ?? [];

    interface PreparedPut {
      type: 'put';
      entity: T;
      request: { PutRequest: { Item: Record<string, unknown> } };
    }
    interface PreparedDelete {
      type: 'delete';
      request: { DeleteRequest: { Key: Record<string, unknown> } };
    }
    type Prepared = PreparedPut | PreparedDelete;

    const prepared: Prepared[] = [];

    for (const item of puts) {
      const entity = this.entityHelpers.instantiate(item);
      this.entityHelpers.applyDefaults(entity);
      await this.entityHelpers.applyHooks(entity, 'beforeInsert');
      this.entityHelpers.validateNonNullable(entity);
      prepared.push({
        type: 'put',
        entity,
        request: {
          PutRequest: { Item: this.entityHelpers.convertToPlainObject(entity) },
        },
      });
    }

    for (const k of deletes) {
      prepared.push({
        type: 'delete',
        request: {
          DeleteRequest: { Key: this.buildItemKey(k.partitionKey, k.sortKey) },
        },
      });
    }

    for (let i = 0; i < prepared.length; i += BATCH_WRITE_CHUNK_SIZE) {
      const chunk = prepared.slice(i, i + BATCH_WRITE_CHUNK_SIZE);
      let pending: typeof chunk = chunk;

      let retries = 0;
      while (pending.length > 0 && retries <= this.maxRetries) {
        const result = await this.wrapSdkCall('batchWrite', () =>
          this.documentClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [this.metadata.tableName]: pending.map((p) => p.request),
              },
            }),
          ),
        );

        const unprocessed = result.UnprocessedItems?.[this.metadata.tableName] ?? [];
        if (unprocessed.length === 0) {
          for (const op of pending) {
            if (op.type === 'put') {
              await this.entityHelpers.applyHooks(op.entity, 'afterInsert');
            }
          }
          pending = [];
          break;
        }

        // Match unprocessed items to our `pending` array by a stable
        // structural key derived from the entity's partition+sort key. We
        // CANNOT use `JSON.stringify(request)` because property order is not
        // guaranteed to survive the SDK round-trip — a misclassification
        // would cause the afterInsert hook to fire for an item DynamoDB
        // actually rejected (silent data loss).
        const pk = this.metadata.keys.partitionKey;
        const sk = this.metadata.keys.sortKey;
        const stableKey = (req: { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } }) => {
          const payload = req.PutRequest?.Item ?? req.DeleteRequest?.Key ?? {};
          const type = req.PutRequest ? 'P' : 'D';
          return `${type}|${JSON.stringify([payload[pk], sk ? payload[sk] : null])}`;
        };

        const unprocessedKeys = new Set(unprocessed.map((u) => stableKey(u as { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } })));
        const stillPending: typeof chunk = [];
        const processedNow: typeof chunk = [];
        for (const p of pending) {
          if (unprocessedKeys.has(stableKey(p.request))) {
            stillPending.push(p);
          } else {
            processedNow.push(p);
          }
        }
        for (const op of processedNow) {
          if (op.type === 'put') {
            await this.entityHelpers.applyHooks(op.entity, 'afterInsert');
          }
        }
        pending = stillPending;
        retries++;
        if (retries <= this.maxRetries && pending.length > 0) {
          await this.delayWithJitter(retries);
        }
      }

      if (pending.length > 0) {
        throw new DynamoDBOrmError(
          `batchWrite failed to process ${pending.length} items after ${this.maxRetries} retries`,
          { entity: this.entity.name, operation: 'batchWrite', unprocessed: pending.length },
        );
      }
    }
  }

  /**
   * Execute a DynamoDB transaction. Wraps `TransactWriteItem` (max 100 ops).
   *
   * Each operation must already reference the entity's table — the lib
   * fills in `TableName` from metadata when omitted.
   */
  async transactWrite(
    operations: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ): Promise<void> {
    if (operations.length === 0) return;
    if (operations.length > TRANSACT_WRITE_MAX_OPS) {
      throw new ValidationError(
        `transactWrite supports at most ${TRANSACT_WRITE_MAX_OPS} operations, got ${operations.length}`,
        { entity: this.entity.name, operation: 'transactWrite' },
      );
    }

    // Shallow-clone each operation so we never mutate the caller's array.
    const withTable = operations.map((op) => {
      const cloned: typeof op = { ...op };
      const fillTable = <O extends { TableName?: string }>(action?: O): O | undefined =>
        action && !action.TableName ? { ...action, TableName: this.metadata.tableName } : action;
      if (cloned.Put) cloned.Put = fillTable(cloned.Put);
      if (cloned.Update) cloned.Update = fillTable(cloned.Update);
      if (cloned.Delete) cloned.Delete = fillTable(cloned.Delete);
      if (cloned.ConditionCheck) cloned.ConditionCheck = fillTable(cloned.ConditionCheck);
      return cloned;
    });

    await this.wrapSdkCall('transactWrite', () =>
      this.documentClient.send(new TransactWriteCommand({ TransactItems: withTable })),
    );
  }

  private resolveIndex(indexName?: string): ResolvedIndex {
    if (!indexName) {
      return {
        partitionKey: this.metadata.keys.partitionKey,
        sortKey: this.metadata.keys.sortKey,
        type: 'TABLE',
      };
    }
    const index = this.metadata.indexes.find((idx) => idx.name === indexName);
    if (!index) {
      throw new MetadataError(
        `Index '${indexName}' not found in entity ${this.entity.name} metadata`,
        { entity: this.entity.name, indexName },
      );
    }
    if (index.type === 'GSI') {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return { partitionKey: index.partitionKey!, sortKey: index.sortKey, type: 'GSI' };
    }
    return { partitionKey: this.metadata.keys.partitionKey, sortKey: index.sortKey, type: 'LSI' };
  }

  private buildQueryParams(
    partitionKey: DynamoKeyType,
    options?: QueryOptions<T> & { exclusiveStartKey?: Record<string, unknown> },
  ) {
    const resolvedKeys = this.resolveIndex(options?.indexName);

    const expressionAttributeNames: Record<string, string> = {
      [KEY_PLACEHOLDERS.PARTITION_KEY]: resolvedKeys.partitionKey,
    };

    const expressionAttributeValues: Record<string, unknown> = {
      ':pk': partitionKey,
    };

    let keyConditionExpression = `${KEY_PLACEHOLDERS.PARTITION_KEY} = :pk`;

    const sortKeyCondition: SortKeyCondition | undefined = options?.sortKeyCondition;

    if (sortKeyCondition && resolvedKeys.sortKey) {
      expressionAttributeNames[KEY_PLACEHOLDERS.SORT_KEY] = resolvedKeys.sortKey;
      const skExpr = this.buildSortKeyConditionExpression(
        sortKeyCondition,
        expressionAttributeValues,
      );
      if (skExpr) {
        keyConditionExpression += ` AND ${skExpr}`;
      }
    }

    const primaryKeysToIgnore = this.getPrimaryKeysToIgnore(options?.indexName);
    const filterResult = this.filterBuilder.buildFilterExpressions(
      options?.filters as Record<string, import('./dynamodb-orm.types').QueryFilters> | undefined,
      primaryKeysToIgnore,
    );

    const mergedNames = {
      ...expressionAttributeNames,
      ...filterResult.ExpressionAttributeNames,
    };
    const mergedValues = {
      ...expressionAttributeValues,
      ...filterResult.ExpressionAttributeValues,
    };

    const projectionExpression = this.filterBuilder.buildProjectionExpression(
      options?.select,
      mergedNames,
    );

    return {
      TableName: this.metadata.tableName,
      IndexName: options?.indexName,
      KeyConditionExpression: keyConditionExpression,
      FilterExpression: filterResult.FilterExpression,
      ExpressionAttributeNames: mergedNames,
      ExpressionAttributeValues: mergedValues,
      ProjectionExpression: projectionExpression,
      Limit: options?.limit,
      ExclusiveStartKey: options?.exclusiveStartKey,
      ScanIndexForward: !options?.descending,
    };
  }

  private buildSortKeyConditionExpression(
    condition: SortKeyCondition,
    attributeValues: Record<string, unknown>,
  ): string | null {
    const sk = KEY_PLACEHOLDERS.SORT_KEY;

    if ('equals' in condition) {
      attributeValues[':sk'] = condition.equals;
      return `${sk} = :sk`;
    }
    if ('beginsWith' in condition) {
      attributeValues[':sk'] = condition.beginsWith;
      return `begins_with(${sk}, :sk)`;
    }
    if ('between' in condition) {
      const [lo, hi] = condition.between;
      attributeValues[':sk_lo'] = lo;
      attributeValues[':sk_hi'] = hi;
      return `${sk} BETWEEN :sk_lo AND :sk_hi`;
    }
    if ('greaterThan' in condition) {
      attributeValues[':sk'] = condition.greaterThan;
      return `${sk} > :sk`;
    }
    if ('lessThan' in condition) {
      attributeValues[':sk'] = condition.lessThan;
      return `${sk} < :sk`;
    }
    if ('greaterThanOrEqual' in condition) {
      attributeValues[':sk'] = condition.greaterThanOrEqual;
      return `${sk} >= :sk`;
    }
    if ('lessThanOrEqual' in condition) {
      attributeValues[':sk'] = condition.lessThanOrEqual;
      return `${sk} <= :sk`;
    }
    return null;
  }

  private buildScanParams(options?: ScanOptions<T>) {
    if (options?.indexName) {
      this.resolveIndex(options.indexName);
    }

    const filterResult = this.filterBuilder.buildFilterExpressions(
      options?.filters as Record<string, import('./dynamodb-orm.types').QueryFilters> | undefined,
    );
    const finalNames = { ...filterResult.ExpressionAttributeNames };
    const projectionExpression = this.filterBuilder.buildProjectionExpression(
      options?.select,
      finalNames,
    );

    return {
      TableName: this.metadata.tableName,
      IndexName: options?.indexName,
      FilterExpression: filterResult.FilterExpression,
      ExpressionAttributeNames: finalNames,
      ExpressionAttributeValues: filterResult.ExpressionAttributeValues,
      ProjectionExpression: projectionExpression,
      Limit: options?.limit,
      ExclusiveStartKey: options?.exclusiveStartKey,
    };
  }

  private buildUpdateParams(
    entity: T,
    options?: UpdateOptions,
    presentFields?: Set<string>,
  ): UpdateCommandInput {
    const plainObject = this.entityHelpers.convertToPlainObject(entity);
    const keys = this.metadata.keys;
    const nullHandling = options?.nullHandling ?? 'remove';
    const fieldsToUpdate = presentFields ?? new Set(Object.keys(plainObject));

    if (isMissingKey(plainObject[keys.partitionKey])) {
      throw new ValidationError(
        `Missing partition key '${keys.partitionKey}' in update operation`,
        { entity: this.entity.name, operation: 'update', key: keys.partitionKey },
      );
    }

    if (keys.sortKey && isMissingKey(plainObject[keys.sortKey])) {
      throw new ValidationError(
        `Missing sort key '${keys.sortKey}' in update operation`,
        { entity: this.entity.name, operation: 'update', key: keys.sortKey },
      );
    }

    const pkVal = plainObject[keys.partitionKey];
    const skVal = keys.sortKey ? plainObject[keys.sortKey] : undefined;

    const updateSets: string[] = [];
    const removeAttrs: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    let index = 0;
    for (const attr of fieldsToUpdate) {
      if (attr === keys.partitionKey) continue;
      if (keys.sortKey && attr === keys.sortKey) continue;

      const val = plainObject[attr];
      if (val === undefined) continue;

      const nameKey = `#attr${index}`;
      const valueKey = `:val${index}`;
      names[nameKey] = attr;

      if (val === null) {
        if (nullHandling === 'persist') {
          updateSets.push(`${nameKey} = ${valueKey}`);
          values[valueKey] = null;
        } else {
          removeAttrs.push(nameKey);
        }
      } else {
        updateSets.push(`${nameKey} = ${valueKey}`);
        values[valueKey] = val;
      }
      index++;
    }

    const updateExpression = [
      updateSets.length && `SET ${updateSets.join(', ')}`,
      removeAttrs.length && `REMOVE ${removeAttrs.join(', ')}`,
    ]
      .filter(Boolean)
      .join(' ');

    if (!updateExpression) {
      throw new ValidationError('No attributes to update', {
        entity: this.entity.name,
        operation: 'update',
      });
    }

    const conditions: string[] = [];
    if (options?.ensureExists) {
      names['#pk_cond'] = keys.partitionKey;
      conditions.push('attribute_exists(#pk_cond)');
    }
    if (options?.conditionExpression) {
      conditions.push(options.conditionExpression);
    }
    const conditionExpression = conditions.length
      ? conditions.join(' AND ')
      : undefined;

    if (options?.conditionExpressionNames) {
      Object.assign(names, options.conditionExpressionNames);
    }
    if (options?.conditionExpressionValues) {
      Object.assign(values, options.conditionExpressionValues);
    }

    const returnValues = options?.returnValues ?? 'ALL_NEW';

    return {
      TableName: this.metadata.tableName,
      Key: {
        [keys.partitionKey]: pkVal,
        ...(keys.sortKey && { [keys.sortKey]: skVal }),
      },
      UpdateExpression: updateExpression,
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      ReturnValues: returnValues,
    };
  }

  private buildItemKey(partitionKey: DynamoKeyType, sortKey?: DynamoKeyType) {
    const key: Record<string, string | number | BinaryType> = {
      [this.metadata.keys.partitionKey]: partitionKey,
    };

    if (sortKey !== undefined && sortKey !== null && this.metadata.keys.sortKey) {
      key[this.metadata.keys.sortKey] = sortKey;
    }

    return key;
  }

  private getPrimaryKeysToIgnore(indexName?: string): string[] {
    const resolved = this.resolveIndex(indexName);
    return resolved.type === 'LSI'
      ? [this.metadata.keys.partitionKey]
      : ([this.metadata.keys.partitionKey, this.metadata.keys.sortKey].filter(Boolean) as string[]);
  }

  /**
   * Maps AWS SDK exceptions to typed lib errors. The map is the policy;
   * the function body is the mechanism. Adding a new mapping is one line.
   */
  private static readonly SDK_ERROR_MAP: Record<
    string,
    (entityName: string, operation: string, message: string, context: Record<string, unknown>) => DynamoDBOrmError
  > = {
    ConditionalCheckFailedException: (e, op, _m, ctx) =>
      new ConditionFailedError(`Condition check failed for ${e} during ${op}`, ctx),
    ProvisionedThroughputExceededException: (e, op, _m, ctx) =>
      new ThroughputExceededError(`Throughput exceeded for ${e} during ${op}`, ctx),
    ThrottlingException: (e, op, _m, ctx) =>
      new ThroughputExceededError(`Request throttled for ${e} during ${op}`, ctx),
    ValidationException: (e, op, msg, ctx) =>
      new ValidationError(`Validation failed for ${e} during ${op}: ${msg}`, ctx),
    ResourceNotFoundException: (e, op, _m, ctx) =>
      new EntityNotFoundError(`Resource not found for ${e} during ${op}`, ctx),
    TransactionCanceledException: (e, op, _m, ctx) =>
      new ConditionFailedError(`Transaction canceled for ${e} during ${op}`, ctx),
    AccessDeniedException: (e, op, _m, ctx) =>
      new DynamoDBOrmError(
        `Access denied for ${e} during ${op}. ` +
          `Check IAM permissions for table ${ctx.table} ` +
          `(required: dynamodb:GetItem / PutItem / UpdateItem / DeleteItem / Query / Scan / BatchGetItem / BatchWriteItem).`,
        { ...ctx, code: 'AccessDenied' },
      ),
  };

  private async wrapSdkCall<R>(operation: string, fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (error instanceof DynamoDBOrmError) throw error;

      const errorName = error instanceof Error ? error.name : '';
      const errorMessage = error instanceof Error ? error.message : String(error);
      const context = { entity: this.entity.name, operation, table: this.metadata.tableName };

      const mapper = DynamoDBOrmRepository.SDK_ERROR_MAP[errorName];
      if (mapper) {
        throw mapper(this.entity.name, operation, errorMessage, context);
      }
      throw new DynamoDBOrmError(
        `DynamoDB operation failed for ${this.entity.name} during ${operation}: ${errorMessage}`,
        context,
      );
    }
  }

  private get maxRetries(): number {
    return this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private delayWithJitter(retryAttempt: number): Promise<void> {
    const baseDelay = Math.pow(2, retryAttempt) * RETRY_BASE_DELAY_MS;
    const jitter = Math.random() * baseDelay;
    return new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
  }

  private async paginate<
    O extends {
      limit?: number;
      maxScanned?: number;
      exclusiveStartKey?: Record<string, unknown>;
    }
  >(
    executor: (options?: O) => Promise<{
      items: T[];
      lastEvaluatedKey: Record<string, unknown> | null;
      scannedCount: number;
    }>,
    options: O | undefined,
    noLimitWarning: string,
  ): Promise<{ items: T[]; lastEvaluatedKey: Record<string, unknown> | null }> {
    if (!options?.limit && !options?.maxScanned) {
      this.logger.warn(noLimitWarning, { entity: this.entity.name });
    }

    const requestedLimit = options?.limit;
    const maxScanned = options?.maxScanned;

    if (!requestedLimit && !maxScanned) {
      return executor(options);
    }

    const allItems: T[] = [];
    let exclusiveStartKey = options?.exclusiveStartKey;
    let hasMore = true;
    let totalScanned = 0;

    while (hasMore && (!requestedLimit || allItems.length < requestedLimit)) {
      const currentOptions = {
        ...options,
        limit: requestedLimit
          ? Math.max(1, requestedLimit - allItems.length)
          : this.options.pageSize,
        exclusiveStartKey,
      } as O;

      const result = await executor(currentOptions);
      allItems.push(...result.items);
      totalScanned += result.scannedCount;
      exclusiveStartKey = result.lastEvaluatedKey ?? undefined;
      hasMore = !!exclusiveStartKey;

      if (maxScanned && totalScanned >= maxScanned) {
        break;
      }

      this.log('Pagination:', {
        current: allItems.length,
        requested: requestedLimit,
        totalScanned,
        hasMore,
      });
    }

    return {
      items: requestedLimit ? allItems.slice(0, requestedLimit) : allItems,
      lastEvaluatedKey: exclusiveStartKey ?? null,
    };
  }
}
