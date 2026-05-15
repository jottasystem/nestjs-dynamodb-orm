import 'reflect-metadata';
import {
  Table,
  PartitionKey,
  SortKey,
  Attribute,
  Index,
} from '../dynamodb-orm-decorators/entity.decorators';
import { DynamoDBOrmRepository } from '../dynamodb-orm.repository';
import {
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DynamoDBOrmError,
  ValidationError,
  ConditionFailedError,
} from '../dynamodb-orm.errors';
import { FilterBuilder } from '../dynamodb-orm.filter-builder';
import { createDocumentClient } from '../dynamodb-orm.document-client';

// ---------------------------------------------------------------------------
// N1 — update() must NOT SET class-field initializers
// ---------------------------------------------------------------------------

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/class-init-test')
class ClassInitEntity {
  @PartitionKey()
  pk!: string;

  @SortKey()
  sk!: string;

  @Attribute()
  name?: string;

  // Class field initializer — would leak into every update() pre-fix
  @Attribute({ default: 'active' })
  status: string = 'active';
}

describe('N1 regression: update() ignores class-field initializers', () => {
  it('update() does NOT emit SET clauses for fields with class-field initializers that were not in the partial', async () => {
    const mockSend = jest.fn().mockResolvedValue({ Attributes: {} });
    const noopLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const repo = new DynamoDBOrmRepository<ClassInitEntity>(
      ClassInitEntity,
      { send: mockSend } as any,
      {},
      noopLogger,
    );

    await repo.update({ pk: 'a', sk: 'b', name: 'new-name' });

    const command = mockSend.mock.calls[0][0];
    const updateExpression = command.input.UpdateExpression as string;
    const attributeNames = command.input.ExpressionAttributeNames as Record<string, string>;

    // The status field has a class-field initializer = 'active' on the
    // instance. The partial did NOT include `status`. The bug was that
    // `Object.keys(new Entity())` included `status`, so buildUpdateParams
    // emitted `SET #status = 'active'` overwriting the real DB value.
    expect(updateExpression).toContain('SET');
    const expressionAttrs = Object.values(attributeNames);
    expect(expressionAttrs).toContain('name');
    expect(expressionAttrs).not.toContain('status');
  });

  it('update() DOES emit SET for fields the hook genuinely adds', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/hook-add-test')
    class HookAddEntity {
      @PartitionKey()
      pk!: string;

      @SortKey()
      sk!: string;

      @Attribute()
      name?: string;

      @Attribute()
      updatedAt?: string;
    }

    // BeforeUpdate hook is declared by adding the prop after the fact, since
    // decorator registration runs at class definition time. Simulate by
    // injecting hook metadata.
    const proto = HookAddEntity.prototype as any;
    proto.onUpd = function () {
      this.updatedAt = '2024-01-01T00:00:00.000Z';
    };
    const { ensureHookMetadata } = await import('../dynamodb-orm.metadata-store');
    ensureHookMetadata(HookAddEntity).beforeUpdate.push('onUpd');

    const mockSend = jest.fn().mockResolvedValue({ Attributes: {} });
    const repo = new DynamoDBOrmRepository<HookAddEntity>(
      HookAddEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await repo.update({ pk: 'a', sk: 'b', name: 'x' });
    const cmd = mockSend.mock.calls[0][0];
    const attrs = Object.values(cmd.input.ExpressionAttributeNames as Record<string, string>);
    expect(attrs).toContain('updatedAt');
    expect(attrs).toContain('name');
  });

  // R3-B1: hook value-diff must catch mutations to class-field-initialized
  // properties (previous heuristic excluded ALL initKeys regardless of hook
  // intent and silently dropped the mutation).
  it('R3-B1: update() emits SET for a class-field-initialized property when the hook mutates it', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/r3b1')
    class R3B1Entity {
      @PartitionKey() pk!: string;
      @SortKey() sk!: string;
      @Attribute() name?: string;

      // class-field initializer AND hook touches it
      @Attribute({ default: 'active' })
      status: string = 'active';
    }
    const proto = R3B1Entity.prototype as any;
    proto.onUpd = function () {
      this.status = 'updated-by-hook';
    };
    const { ensureHookMetadata } = await import('../dynamodb-orm.metadata-store');
    ensureHookMetadata(R3B1Entity).beforeUpdate.push('onUpd');

    const mockSend = jest.fn().mockResolvedValue({ Attributes: {} });
    const repo = new DynamoDBOrmRepository<R3B1Entity>(
      R3B1Entity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await repo.update({ pk: 'a', sk: 'b', name: 'x' });
    const cmd = mockSend.mock.calls[0][0];
    const attrNames = Object.values(
      cmd.input.ExpressionAttributeNames as Record<string, string>,
    );
    const attrValues = cmd.input.ExpressionAttributeValues as Record<string, unknown>;

    expect(attrNames).toContain('status');
    expect(Object.values(attrValues)).toContain('updated-by-hook');
  });

  it('R3-B1: update() does NOT touch a class-field-initialized property when the hook leaves it alone', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/r3b1-nohook')
    class NoTouchEntity {
      @PartitionKey() pk!: string;
      @SortKey() sk!: string;
      @Attribute() name?: string;

      @Attribute({ default: 'active' })
      status: string = 'active';
    }

    const mockSend = jest.fn().mockResolvedValue({ Attributes: {} });
    const repo = new DynamoDBOrmRepository<NoTouchEntity>(
      NoTouchEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await repo.update({ pk: 'a', sk: 'b', name: 'x' });
    const cmd = mockSend.mock.calls[0][0];
    const attrNames = Object.values(
      cmd.input.ExpressionAttributeNames as Record<string, string>,
    );
    expect(attrNames).not.toContain('status');
  });
});

// ---------------------------------------------------------------------------
// R3-B2: @GenerateSearchKey must NOT corrupt the search key on partial updates
// ---------------------------------------------------------------------------

describe('R3-B2 regression: GenerateSearchKey skips when all source fields are missing', () => {
  it('partial update that omits search-key source fields does NOT overwrite the existing key', async () => {
    const { GenerateSearchKey } = await import(
      '../dynamodb-orm-decorators/search-key.decorator'
    );

    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/sk-corruption')
    class SkEntity {
      @PartitionKey() pk!: string;
      @SortKey() sk!: string;

      @Attribute() name?: string;
      @Attribute() tags?: string[];
      @Attribute() archived?: boolean;

      @GenerateSearchKey<SkEntity>((p) => ({ name: p.name, tags: p.tags }))
      @Attribute()
      searchKey?: string;
    }

    const mockSend = jest.fn().mockResolvedValue({ Attributes: {} });
    const repo = new DynamoDBOrmRepository<SkEntity>(
      SkEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    // Update toggles `archived` only. The selector fields (name, tags) are
    // not present in the partial; the pre-R3-B2 bug would compute the
    // search key as "||" and SET it, destroying the indexed value.
    await repo.update({ pk: 'a', sk: 'b', archived: true });

    const cmd = mockSend.mock.calls[0][0];
    const attrNames = Object.values(
      cmd.input.ExpressionAttributeNames as Record<string, string>,
    );
    expect(attrNames).toContain('archived');
    expect(attrNames).not.toContain('searchKey');
  });

  it('partial update that includes search-key source fields DOES recompute the key', async () => {
    const { GenerateSearchKey } = await import(
      '../dynamodb-orm-decorators/search-key.decorator'
    );

    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/sk-update')
    class SkEntity2 {
      @PartitionKey() pk!: string;
      @SortKey() sk!: string;

      @Attribute() name?: string;

      @GenerateSearchKey<SkEntity2>((p) => ({ name: p.name }))
      @Attribute()
      searchKey?: string;
    }

    const mockSend = jest.fn().mockResolvedValue({ Attributes: {} });
    const repo = new DynamoDBOrmRepository<SkEntity2>(
      SkEntity2,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await repo.update({ pk: 'a', sk: 'b', name: 'NewName' });

    const cmd = mockSend.mock.calls[0][0];
    const attrNames = Object.values(
      cmd.input.ExpressionAttributeNames as Record<string, string>,
    );
    const attrValues = cmd.input.ExpressionAttributeValues as Record<string, unknown>;

    expect(attrNames).toContain('name');
    expect(attrNames).toContain('searchKey');
    expect(Object.values(attrValues)).toContain('newname');
  });
});

// ---------------------------------------------------------------------------
// R3-M1: cloneDefault must clone Map KEYS too
// ---------------------------------------------------------------------------

describe('R3-M1 regression: cloneDefault clones Map keys', () => {
  it('two entities sharing a Map default with object keys do NOT alias keys', async () => {
    const objKey = { id: 'shared' };
    const sharedDefault = new Map<{ id: string }, string>([[objKey, 'v1']]);

    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/r3m1')
    class MapKeyEntity {
      @PartitionKey() pk!: string;

      @Attribute({ default: sharedDefault })
      data!: Map<{ id: string }, string>;
    }

    const { EntityHelpers } = await import('../dynamodb-orm.entity-helpers');
    const helpers = new EntityHelpers<MapKeyEntity>(MapKeyEntity);

    const a = {} as MapKeyEntity;
    const b = {} as MapKeyEntity;
    helpers.applyDefaults(a);
    helpers.applyDefaults(b);

    const aKey = Array.from(a.data.keys())[0];
    const bKey = Array.from(b.data.keys())[0];

    expect(aKey).not.toBe(bKey);
    expect(aKey).toEqual({ id: 'shared' });
    expect(bKey).toEqual({ id: 'shared' });

    aKey.id = 'mutated';
    expect(bKey.id).toBe('shared');
  });
});

// ---------------------------------------------------------------------------
// R3-M2: @Index does NOT invent a sort key from the attribute name
// ---------------------------------------------------------------------------

describe('R3-M2 regression: @Index leaves sortKey undefined when caller does not declare one', () => {
  it('GSI without explicit sortKey records sortKey: undefined in metadata', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/r3m2')
    class GsiEntity {
      @PartitionKey() pk!: string;

      @Index({ type: 'GSI', partitionKey: 'email' })
      @Attribute()
      email?: string;
    }

    const { getEntityMetadata } = await import('../dynamodb-orm.metadata-store');
    const meta = getEntityMetadata(GsiEntity);
    const idx = meta.indexes.find((i) => i.attribute === 'email');
    expect(idx).toBeDefined();
    expect(idx!.sortKey).toBeUndefined();
  });

  it('LSI uses the decorated property as sort key (DynamoDB semantics)', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/r3m2-lsi')
    class LsiEntity {
      @PartitionKey() pk!: string;

      @Index({ type: 'LSI' })
      @Attribute()
      searchKey?: string;
    }

    const { getEntityMetadata } = await import('../dynamodb-orm.metadata-store');
    const meta = getEntityMetadata(LsiEntity);
    const idx = meta.indexes.find((i) => i.attribute === 'searchKey');
    expect(idx!.sortKey).toBe('searchKey');
  });
});

// ---------------------------------------------------------------------------
// R3-L1: FilterBuilder throws ValidationError (hierarchy consistency)
// ---------------------------------------------------------------------------

describe('R3-L1 regression: FilterBuilder throws ValidationError, not plain Error', () => {
  it('unknown operator throws ValidationError', async () => {
    const { FilterBuilder } = await import('../dynamodb-orm.filter-builder');
    const fb = new FilterBuilder({
      attributes: {},
      keys: { partitionKey: 'pk' },
      indexes: [],
      tableName: 't',
      tableArn: 'arn',
      region: 'us-east-1',
    });
    expect(() =>
      fb.buildFilterExpressions({ field: { bogus: 'x' } as any }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// R3-L7: AccessDeniedException maps with helpful guidance
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Polish-round regressions
// ---------------------------------------------------------------------------

describe('serializeValue cycle detection (ancestors, not visited)', () => {
  it('accepts sibling fields that share a non-cyclic reference', async () => {
    const { EntityHelpers } = await import('../dynamodb-orm.entity-helpers');

    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/shared-ref')
    class SharedRefEntity {
      @PartitionKey() pk!: string;
    }

    const helpers = new EntityHelpers<SharedRefEntity>(SharedRefEntity);
    const sharedLeaf = { value: 42 };
    const entity = {
      pk: 'a',
      a: { nested: sharedLeaf },
      b: { nested: sharedLeaf },
    } as unknown as SharedRefEntity;

    expect(() => helpers.convertToPlainObject(entity)).not.toThrow();
    const result = helpers.convertToPlainObject(entity) as Record<string, any>;
    expect(result.a.nested).toEqual({ value: 42 });
    expect(result.b.nested).toEqual({ value: 42 });
  });

  it('still throws on actual cycles (the same object on a path that loops back)', async () => {
    const { EntityHelpers } = await import('../dynamodb-orm.entity-helpers');

    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/real-cycle')
    class CycleEntity {
      @PartitionKey() pk!: string;
    }

    const helpers = new EntityHelpers<CycleEntity>(CycleEntity);
    const entity: any = { pk: 'a' };
    entity.self = entity;

    expect(() => helpers.convertToPlainObject(entity)).toThrow(ValidationError);
  });
});

describe('batchWrite stable key for DeleteRequest', () => {
  it('distinguishes Put and Delete with the same pk/sk during retry classification', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/put-vs-delete')
    class PvDEntity {
      @PartitionKey() pk!: string;
      @SortKey() sk!: string;
      @Attribute() name?: string;
    }

    const mockSend = jest
      .fn()
      // First call: a Put (pk=a, sk=1) and a Delete (pk=a, sk=1) sent.
      // SDK reports Delete as unprocessed; Put succeeds.
      .mockResolvedValueOnce({
        UnprocessedItems: {
          'put-vs-delete': [{ DeleteRequest: { Key: { pk: 'a', sk: '1' } } }],
        },
      })
      // Retry succeeds.
      .mockResolvedValueOnce({});

    const repo = new DynamoDBOrmRepository<PvDEntity>(
      PvDEntity,
      { send: mockSend } as any,
      { maxRetries: 2 },
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await repo.batchWrite({
      puts: [{ pk: 'a', sk: '1', name: 'n' }],
      deletes: [{ partitionKey: 'a', sortKey: '1' }],
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    const retryCall = mockSend.mock.calls[1][0];
    const retryRequests = retryCall.input.RequestItems['put-vs-delete'];
    expect(retryRequests).toHaveLength(1);
    expect(retryRequests[0]).toEqual({ DeleteRequest: { Key: { pk: 'a', sk: '1' } } });
  });
});

describe('create() applies defaults INTO the Item sent to DynamoDB', () => {
  it('Put request includes defaults that the user did not supply', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/defaults-flow')
    class DefaultsEntity {
      @PartitionKey() pk!: string;
      @Attribute({ default: 'active' }) status?: string;
      @Attribute({ default: () => ['a', 'b'] }) tags?: string[];
    }

    const mockSend = jest.fn().mockResolvedValue({});
    const repo = new DynamoDBOrmRepository<DefaultsEntity>(
      DefaultsEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await repo.create({ pk: 'x' });
    const command = mockSend.mock.calls[0][0];
    expect(command.input.Item).toEqual({
      pk: 'x',
      status: 'active',
      tags: ['a', 'b'],
    });
  });
});

describe('R3-L7 regression: AccessDeniedException is mapped at runtime', () => {
  it('repository operations rethrow AccessDeniedException as DynamoDBOrmError with IAM hint', async () => {
    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/r3l7')
    class AccessEntity {
      @PartitionKey() pk!: string;
    }
    const mockSend = jest.fn().mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );
    const repo = new DynamoDBOrmRepository<AccessEntity>(
      AccessEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );
    await expect(repo.findOne('a')).rejects.toThrow(/Access denied.*IAM/);
  });
});

// ---------------------------------------------------------------------------
// N2 — all advertised filter operators must produce DynamoDB expressions
// ---------------------------------------------------------------------------

describe('N2 regression: every operator declared in QueryFilters produces an expression', () => {
  const fakeMetadata = {
    attributes: {},
    keys: { partitionKey: 'pk' },
    indexes: [],
    tableName: 't',
    tableArn: 'arn:aws:dynamodb:us-east-1:0:table/t',
    region: 'us-east-1',
  };

  it.each([
    ['equals', { equals: 'v' }, '#attr0 = :val0'],
    ['notEquals', { notEquals: 'v' }, '#attr0 <> :val0'],
    ['beginsWith', { beginsWith: 'v' }, 'begins_with(#attr0, :val0)'],
    ['between', { between: ['a', 'z'] }, '#attr0 BETWEEN :val0 AND :val1'],
    ['greaterThan', { greaterThan: 1 }, '#attr0 > :val0'],
    ['greaterThanOrEqual', { greaterThanOrEqual: 1 }, '#attr0 >= :val0'],
    ['lessThan', { lessThan: 1 }, '#attr0 < :val0'],
    ['lessThanOrEqual', { lessThanOrEqual: 1 }, '#attr0 <= :val0'],
    ['in', { in: ['a', 'b'] }, '#attr0 IN (:val0, :val1)'],
    ['notIn', { notIn: ['a', 'b'] }, 'NOT (#attr0 IN (:val0, :val1))'],
    ['exists-true', { exists: true }, 'attribute_exists(#attr0)'],
    ['exists-false', { exists: false }, 'attribute_not_exists(#attr0)'],
  ])('operator %s produces correct expression', (_label, filter, expectedExpr) => {
    const fb = new FilterBuilder(fakeMetadata);
    const result = fb.buildFilterExpressions({ field: filter as any });
    expect(result.FilterExpression).toBe(expectedExpr);
  });

  it('contains with single value produces contains(...)', () => {
    const fb = new FilterBuilder(fakeMetadata);
    const result = fb.buildFilterExpressions({ field: { contains: 'v' } });
    expect(result.FilterExpression).toBe('contains(#attr0, :val0)');
  });

  it('contains with array produces OR of contains(...)', () => {
    const fb = new FilterBuilder(fakeMetadata);
    const result = fb.buildFilterExpressions({ field: { contains: ['a', 'b'] } });
    expect(result.FilterExpression).toBe('(contains(#attr0, :val0) OR contains(#attr0, :val1))');
  });

  it('unknown operator THROWS instead of silently no-oping', () => {
    const fb = new FilterBuilder(fakeMetadata);
    expect(() =>
      fb.buildFilterExpressions({ field: { bogusOperator: 'x' } as any }),
    ).toThrow(/Unsupported filter operator/);
  });
});

// ---------------------------------------------------------------------------
// N3 — forFeature does not shadow forRoot
// ---------------------------------------------------------------------------

describe('N3 regression: forFeature optional injection lets forRoot win', () => {
  it('forFeature provider inject list uses { optional: true } so global forRoot reaches the repository', async () => {
    const { DynamoDBOrmModule } = await import('../dynamodb-orm.module');

    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/n3-test')
    class N3Entity {
      @PartitionKey() pk!: string;
    }

    const feature = DynamoDBOrmModule.forFeature([N3Entity]);
    const repoProvider = (feature.providers as any[]).find((p) =>
      String(p.provide).includes('N3Entity'),
    );
    for (const dep of repoProvider.inject) {
      expect(dep.optional).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// N4 — batchWrite stable structural key
// ---------------------------------------------------------------------------

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/n4-test')
class N4Entity {
  @PartitionKey()
  pk!: string;

  @SortKey()
  sk!: string;

  @Attribute()
  name!: string;
}

describe('N4 regression: batchWrite retry uses stable structural key, not JSON.stringify(request)', () => {
  it('correctly identifies still-unprocessed items even if SDK reorders object keys', async () => {
    const noopLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const afterInsertCalls: string[] = [];

    @Table('arn:aws:dynamodb:us-east-1:000000000000:table/n4-test-2')
    class N4HookEntity {
      @PartitionKey() pk!: string;
      @SortKey() sk!: string;
      @Attribute() name?: string;
    }
    const proto = N4HookEntity.prototype as any;
    proto.onAfterInsert = function () {
      afterInsertCalls.push(this.sk);
    };
    const { ensureHookMetadata } = await import('../dynamodb-orm.metadata-store');
    ensureHookMetadata(N4HookEntity).afterInsert.push('onAfterInsert');

    const mockSend = jest
      .fn()
      // First call: report sk='2' as unprocessed (with REORDERED keys vs how we sent it)
      .mockResolvedValueOnce({
        UnprocessedItems: {
          'n4-test-2': [
            {
              PutRequest: {
                Item: {
                  // Intentionally reorder vs the lib's send: name first, then sk, then pk
                  name: 'second',
                  sk: '2',
                  pk: 'a',
                },
              },
            },
          ],
        },
      })
      // Second call: success
      .mockResolvedValueOnce({});

    const repo = new DynamoDBOrmRepository<N4HookEntity>(
      N4HookEntity,
      { send: mockSend } as any,
      { maxRetries: 1 },
      noopLogger,
    );

    await repo.batchWrite({
      puts: [
        { pk: 'a', sk: '1', name: 'first' },
        { pk: 'a', sk: '2', name: 'second' },
      ],
    });

    // afterInsert MUST fire for sk='1' (processed in first call) and sk='2'
    // (processed in second). With the buggy JSON.stringify matcher, sk='2'
    // could be misclassified as processed in the first call because the
    // SDK's reordered version doesn't stringify-equal our sent version.
    expect(afterInsertCalls.sort()).toEqual(['1', '2']);
  });
});

// ---------------------------------------------------------------------------
// N5 — batchGet keyOf is collision-safe even with `::` in key values
// ---------------------------------------------------------------------------

describe('N5 regression: batchGet keyOf cannot collide between distinct keys', () => {
  it('treats keys differing only in delimiter positions as distinct', async () => {
    const mockSend = jest.fn().mockResolvedValueOnce({
      Responses: {
        'n4-test': [
          { pk: 'a::b', sk: 'c', name: 'one' },
          { pk: 'a', sk: 'b::c', name: 'two' },
        ],
      },
    });
    const noopLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const repo = new DynamoDBOrmRepository<N4Entity>(
      N4Entity,
      { send: mockSend } as any,
      {},
      noopLogger,
    );

    const result = await repo.batchGet([
      { partitionKey: 'a::b', sortKey: 'c' },
      { partitionKey: 'a', sortKey: 'b::c' },
    ]);

    expect(result.items).toHaveLength(2);
    expect(result.missingKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H1 — transactWrite full coverage
// ---------------------------------------------------------------------------

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/tx-test')
class TxEntity {
  @PartitionKey() pk!: string;
  @SortKey() sk!: string;
  @Attribute() name!: string;
}

describe('H1 regression: transactWrite', () => {
  function repo() {
    const mockSend = jest.fn().mockResolvedValue({});
    const noopLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const r = new DynamoDBOrmRepository<TxEntity>(
      TxEntity,
      { send: mockSend } as any,
      {},
      noopLogger,
    );
    return { r, mockSend };
  }

  it('returns immediately when operations is empty', async () => {
    const { r, mockSend } = repo();
    await r.transactWrite([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws ValidationError when operations.length > 100', async () => {
    const { r } = repo();
    const ops = Array.from({ length: 101 }, () => ({
      Put: { Item: { pk: 'a', sk: 'b' } },
    }));
    await expect(r.transactWrite(ops as any)).rejects.toBeInstanceOf(ValidationError);
  });

  it('fills TableName when omitted in the input', async () => {
    const { r, mockSend } = repo();
    await r.transactWrite([{ Put: { Item: { pk: 'a', sk: 'b' } } as any }]);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(TransactWriteCommand);
    expect(cmd.input.TransactItems[0].Put.TableName).toBe('tx-test');
  });

  it('does NOT mutate the caller-supplied operation objects', async () => {
    const { r } = repo();
    const op = { Put: { Item: { pk: 'a', sk: 'b' } } as any };
    await r.transactWrite([op]);
    expect(op.Put.TableName).toBeUndefined();
  });

  it('respects an explicit TableName (cross-table transaction support)', async () => {
    const { r, mockSend } = repo();
    await r.transactWrite([
      { Put: { TableName: 'other-table', Item: { x: 1 } } as any },
    ]);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.TransactItems[0].Put.TableName).toBe('other-table');
  });

  it('maps TransactionCanceledException → ConditionFailedError', async () => {
    const mockSend = jest.fn().mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' }),
    );
    const r = new DynamoDBOrmRepository<TxEntity>(
      TxEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );
    await expect(
      r.transactWrite([{ Put: { Item: { pk: 'a', sk: 'b' } } as any }]),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });
});

// ---------------------------------------------------------------------------
// H2 — custom client bypass (options.client) returns it as-is
// ---------------------------------------------------------------------------

describe('H2 regression: custom DocumentClient via options.client is returned as-is', () => {
  it('returns the injected client without modification', () => {
    const fakeClient = { send: jest.fn(), tag: 'CUSTOM' } as any;
    const result = createDocumentClient(
      {
        attributes: {},
        keys: { partitionKey: 'pk' },
        indexes: [],
        tableName: 't',
        tableArn: 'arn:aws:dynamodb:us-east-1:0:table/t',
        region: 'us-east-1',
      },
      { client: fakeClient },
    );
    expect(result).toBe(fakeClient);
  });
});

// ---------------------------------------------------------------------------
// H3 — TableManager KeySchema validation
// ---------------------------------------------------------------------------

import { TableManager } from '../dynamodb-orm.table-manager';
import {
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: jest.fn(),
    DescribeTableCommand: jest.fn().mockImplementation((input) => ({ input })),
  };
});

describe('H3 regression: TableManager validates live KeySchema against entity', () => {
  const arn = 'arn:aws:dynamodb:us-east-1:000000000000:table/h3-test';
  let mockSend: jest.Mock;
  let manager: TableManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend = jest.fn();
    (DynamoDBClient as unknown as jest.Mock).mockImplementation(() => ({
      send: mockSend,
    }));
    manager = new TableManager();
  });

  it('passes when partitionKey and sortKey match', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      },
    });
    await expect(
      manager.validateTableArn(arn, { partitionKey: 'pk', sortKey: 'sk' }),
    ).resolves.toBeUndefined();
  });

  it('throws on partition-key mismatch', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        KeySchema: [{ AttributeName: 'wrong_pk', KeyType: 'HASH' }],
      },
    });
    await expect(
      manager.validateTableArn(arn, { partitionKey: 'pk' }),
    ).rejects.toThrow(/partition key/);
  });

  it('throws on sort-key mismatch', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'wrong_sk', KeyType: 'RANGE' },
        ],
      },
    });
    await expect(
      manager.validateTableArn(arn, { partitionKey: 'pk', sortKey: 'sk' }),
    ).rejects.toThrow(/sort key/);
  });

  it('throws when entity has no sort key but table does', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'extra_sk', KeyType: 'RANGE' },
        ],
      },
    });
    await expect(
      manager.validateTableArn(arn, { partitionKey: 'pk' }),
    ).rejects.toThrow(/has sort key 'extra_sk' but entity does not declare one/);
  });

  it('throws when entity declares sort key but table has none', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      },
    });
    await expect(
      manager.validateTableArn(arn, { partitionKey: 'pk', sortKey: 'sk' }),
    ).rejects.toThrow(/Entity declares sort key 'sk' but table .* has none/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty inputs
// ---------------------------------------------------------------------------

describe('Empty-input edge cases', () => {
  function noopRepo() {
    const mockSend = jest.fn();
    const r = new DynamoDBOrmRepository<TxEntity>(
      TxEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );
    return { r, mockSend };
  }

  it('batchGet([]) returns empty result without calling the SDK', async () => {
    const { r, mockSend } = noopRepo();
    const result = await r.batchGet([]);
    expect(result).toEqual({ items: [], missingKeys: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('batchWrite({ puts: [], deletes: [] }) does not call the SDK', async () => {
    const { r, mockSend } = noopRepo();
    await r.batchWrite({ puts: [], deletes: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('batchWrite([]) (legacy array form) does not call the SDK', async () => {
    const { r, mockSend } = noopRepo();
    await r.batchWrite([]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Async hook rejection propagates
// ---------------------------------------------------------------------------

describe('Async hook rejection', () => {
  @Table('arn:aws:dynamodb:us-east-1:000000000000:table/async-hook-test')
  class AsyncHookEntity {
    @PartitionKey() pk!: string;
    @SortKey() sk!: string;
  }

  it('propagates rejected promise from async beforeInsert hook', async () => {
    const proto = AsyncHookEntity.prototype as any;
    proto.failingHook = async function () {
      throw new Error('boom from async hook');
    };
    const { ensureHookMetadata } = await import('../dynamodb-orm.metadata-store');
    ensureHookMetadata(AsyncHookEntity).beforeInsert.push('failingHook');

    const mockSend = jest.fn();
    const r = new DynamoDBOrmRepository<AsyncHookEntity>(
      AsyncHookEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await expect(r.create({ pk: 'a', sk: 'b' })).rejects.toThrow('boom from async hook');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DynamoDBOrmError catch-all
// ---------------------------------------------------------------------------

describe('Unknown SDK error maps to DynamoDBOrmError', () => {
  it('wraps unrecognised SDK exceptions as DynamoDBOrmError', async () => {
    const mockSend = jest.fn().mockRejectedValueOnce(
      Object.assign(new Error('mystery'), { name: 'SomeUnknownException' }),
    );
    const r = new DynamoDBOrmRepository<TxEntity>(
      TxEntity,
      { send: mockSend } as any,
      {},
      { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );
    await expect(r.findOne('a', 'b')).rejects.toBeInstanceOf(DynamoDBOrmError);
  });
});
