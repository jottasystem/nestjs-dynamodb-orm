import { DynamoDBOrmRepository } from '../dynamodb-orm.repository';
import {
  Table,
  PartitionKey,
  SortKey,
  Attribute,
} from '../dynamodb-orm-decorators/entity.decorators';
import {
  ConditionFailedError,
  DynamoDBOrmError,
  EntityNotFoundError,
  InvalidEntityError,
  ThroughputExceededError,
  ValidationError,
} from '../dynamodb-orm.errors';

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/extras-test')
class ExtrasEntity {
  @PartitionKey()
  pk!: string;

  @SortKey()
  sk!: string;

  @Attribute()
  name!: string;

  @Attribute({ nullable: false })
  required!: string;
}

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/numeric-pk-table')
class NumericKeyEntity {
  @PartitionKey()
  id!: number;

  @SortKey()
  ts!: number;

  @Attribute()
  payload!: string;
}

const mockSend = jest.fn();
const mockClient = { send: mockSend } as any;
const noopLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeRepo<T>(entity: any) {
  return new DynamoDBOrmRepository<T>(entity, mockClient, { maxRetries: 2 }, noopLogger);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// B1 — update() partial validation
// ---------------------------------------------------------------------------
describe('B1: update() accepts partial updates that omit nullable:false fields', () => {
  it('does NOT throw when partial omits a required field that is unrelated to the update', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { pk: 'a', sk: 'b', name: 'new' } });
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);

    await expect(
      repo.update({ pk: 'a', sk: 'b', name: 'new' } as Partial<ExtrasEntity>),
    ).resolves.toBeDefined();
  });

  it('throws InvalidEntityError when the partial DOES include the required field as null', async () => {
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.update({
        pk: 'a',
        sk: 'b',
        required: null,
      } as unknown as Partial<ExtrasEntity>),
    ).rejects.toBeInstanceOf(InvalidEntityError);
  });
});

// ---------------------------------------------------------------------------
// B2 — update() accepts pk = 0 and pk = ''
// ---------------------------------------------------------------------------
describe('B2: update() accepts falsy-but-valid keys', () => {
  it('accepts numeric partition key 0', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { id: 0, ts: 0, payload: 'p' } });
    const repo = makeRepo<NumericKeyEntity>(NumericKeyEntity);

    await expect(
      repo.update({ id: 0, ts: 0, payload: 'p' } as Partial<NumericKeyEntity>),
    ).resolves.toBeDefined();
  });

  it('rejects undefined partition key with ValidationError', async () => {
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.update({ sk: 'b', name: 'x' } as unknown as Partial<ExtrasEntity>),
    ).rejects.toThrow(/partition key/);
  });

  it('rejects undefined sort key with ValidationError', async () => {
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.update({ pk: 'a', name: 'x' } as unknown as Partial<ExtrasEntity>),
    ).rejects.toThrow(/sort key/);
  });
});

// ---------------------------------------------------------------------------
// B3 — batchWrite runs validateNonNullable + afterInsert
// ---------------------------------------------------------------------------
describe('B3: batchWrite enforces validation and runs afterInsert', () => {
  it('throws InvalidEntityError when a put item is missing a nullable:false field', async () => {
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.batchWrite({
        puts: [
          { pk: 'a', sk: 'b', name: 'x' } as Partial<ExtrasEntity>,
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidEntityError);
  });

  it('passes when all required fields are present', async () => {
    mockSend.mockResolvedValueOnce({});
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.batchWrite({
        puts: [{ pk: 'a', sk: 'b', name: 'x', required: 'y' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('supports DeleteRequest in batchWrite', async () => {
    mockSend.mockResolvedValueOnce({});
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await repo.batchWrite({
      deletes: [{ partitionKey: 'a', sortKey: 'b' }],
    });
    const command = mockSend.mock.calls[0][0];
    const writes = command.input.RequestItems['extras-test'];
    expect(writes[0]).toEqual({
      DeleteRequest: { Key: { pk: 'a', sk: 'b' } },
    });
  });

  it('accepts the legacy plain-array form (treats it as puts)', async () => {
    mockSend.mockResolvedValueOnce({});
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.batchWrite([
        { pk: 'a', sk: 'b', name: 'x', required: 'y' },
      ]),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scan() — full coverage of behavior
// ---------------------------------------------------------------------------
describe('scan()', () => {
  it('sends a ScanCommand with TableName and parses items via parseDynamoItem', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ pk: 'a', sk: 'b', name: 'x', required: 'y' }],
      ScannedCount: 1,
    });
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    const result = await repo.scan({ limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toBeInstanceOf(ExtrasEntity);
    expect(result.lastEvaluatedKey).toBeNull();
  });

  it('returns lastEvaluatedKey when DynamoDB returns LastEvaluatedKey', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ pk: 'a', sk: 'b', name: 'n', required: 'r' }],
      ScannedCount: 1,
      LastEvaluatedKey: { pk: 'last' },
    });
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    const result = await repo.scan({ limit: 1 });
    expect(result.lastEvaluatedKey).toEqual({ pk: 'last' });
    expect(result.items).toHaveLength(1);
  });

  it('validates indexName before sending', async () => {
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.scan({ indexName: 'no-such-index', limit: 10 }),
    ).rejects.toThrow(/Index 'no-such-index' not found/);
  });
});

// ---------------------------------------------------------------------------
// paginate() — multi-page loop
// ---------------------------------------------------------------------------
describe('paginate() across multiple pages', () => {
  it('returns the combined items across pages and slices to requested limit', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          { pk: 'a', sk: '1' },
          { pk: 'a', sk: '2' },
        ],
        ScannedCount: 2,
        LastEvaluatedKey: { pk: 'a', sk: '2' },
      })
      .mockResolvedValueOnce({
        Items: [
          { pk: 'a', sk: '3' },
          { pk: 'a', sk: '4' },
        ],
        ScannedCount: 2,
        LastEvaluatedKey: undefined,
      });

    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    const result = await repo.find('a', { limit: 3 });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(3);
  });

  it('respects maxScanned and stops paginating', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [],
      ScannedCount: 100,
      LastEvaluatedKey: { pk: 'a', sk: '100' },
    });

    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    const result = await repo.find('a', { maxScanned: 50 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.lastEvaluatedKey).toEqual({ pk: 'a', sk: '100' });
  });
});

// ---------------------------------------------------------------------------
// batchGet — UnprocessedKeys retry + missingKeys
// ---------------------------------------------------------------------------
describe('batchGet retry on UnprocessedKeys', () => {
  it('retries until UnprocessedKeys is empty', async () => {
    mockSend
      .mockResolvedValueOnce({
        Responses: { 'extras-test': [{ pk: 'a', sk: '1', name: 'x', required: 'y' }] },
        UnprocessedKeys: {
          'extras-test': { Keys: [{ pk: 'a', sk: '2' }] },
        },
      })
      .mockResolvedValueOnce({
        Responses: { 'extras-test': [{ pk: 'a', sk: '2', name: 'y', required: 'z' }] },
      });

    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    const result = await repo.batchGet([
      { partitionKey: 'a', sortKey: '1' },
      { partitionKey: 'a', sortKey: '2' },
    ]);

    expect(result.items).toHaveLength(2);
    expect(result.missingKeys).toHaveLength(0);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('reports missingKeys when items are not returned', async () => {
    mockSend.mockResolvedValueOnce({
      Responses: { 'extras-test': [{ pk: 'a', sk: '1', name: 'x', required: 'y' }] },
    });
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    const result = await repo.batchGet([
      { partitionKey: 'a', sortKey: '1' },
      { partitionKey: 'a', sortKey: 'missing' },
    ]);

    expect(result.items).toHaveLength(1);
    expect(result.missingKeys).toEqual([{ partitionKey: 'a', sortKey: 'missing' }]);
  });

  it('throws DynamoDBOrmError after maxRetries exhausted', async () => {
    mockSend.mockResolvedValue({
      Responses: { 'extras-test': [] },
      UnprocessedKeys: { 'extras-test': { Keys: [{ pk: 'a', sk: '1' }] } },
    });

    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(
      repo.batchGet([{ partitionKey: 'a', sortKey: '1' }]),
    ).rejects.toBeInstanceOf(DynamoDBOrmError);
  });
});

// ---------------------------------------------------------------------------
// batchWrite — UnprocessedItems retry
// ---------------------------------------------------------------------------
describe('batchWrite retry on UnprocessedItems', () => {
  it('retries until UnprocessedItems is empty', async () => {
    const putItem = (sk: string) => ({
      PutRequest: { Item: { pk: 'a', sk, name: 'n', required: 'r' } },
    });

    mockSend
      .mockResolvedValueOnce({
        UnprocessedItems: { 'extras-test': [putItem('1')] },
      })
      .mockResolvedValueOnce({});

    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await repo.batchWrite({
      puts: [{ pk: 'a', sk: '1', name: 'n', required: 'r' }],
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// wrapSdkCall — exhaustive error mapping
// ---------------------------------------------------------------------------
describe('wrapSdkCall maps SDK exceptions to typed errors', () => {
  const cases: Array<[string, new (...args: any[]) => Error]> = [
    ['ConditionalCheckFailedException', ConditionFailedError],
    ['ProvisionedThroughputExceededException', ThroughputExceededError],
    ['ThrottlingException', ThroughputExceededError],
    ['ValidationException', ValidationError],
    ['ResourceNotFoundException', EntityNotFoundError],
    ['TransactionCanceledException', ConditionFailedError],
  ];

  for (const [awsName, ErrorClass] of cases) {
    it(`maps ${awsName} → ${ErrorClass.name}`, async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('sdk failure'), { name: awsName }),
      );
      const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
      await expect(repo.findOne('a', 'b')).rejects.toBeInstanceOf(ErrorClass);
    });
  }

  it('falls through to DynamoDBOrmError for unknown SDK errors', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'SomeNewException' }),
    );
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(repo.findOne('a', 'b')).rejects.toBeInstanceOf(DynamoDBOrmError);
  });
});

// ---------------------------------------------------------------------------
// count() and exists() helpers
// ---------------------------------------------------------------------------
describe('count() and exists()', () => {
  it('exists() returns true when GetItem returns a record', async () => {
    mockSend.mockResolvedValueOnce({ Item: { pk: 'a' } });
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(repo.exists('a', 'b')).resolves.toBe(true);
  });

  it('exists() returns false when GetItem returns no record', async () => {
    mockSend.mockResolvedValueOnce({});
    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    await expect(repo.exists('a', 'b')).resolves.toBe(false);
  });

  it('count() sums Count across pages with Select: COUNT', async () => {
    mockSend
      .mockResolvedValueOnce({
        Count: 50,
        ScannedCount: 50,
        LastEvaluatedKey: { pk: 'a' },
      })
      .mockResolvedValueOnce({
        Count: 30,
        ScannedCount: 30,
      });

    const repo = makeRepo<ExtrasEntity>(ExtrasEntity);
    const total = await repo.count('a');
    expect(total).toBe(80);

    const firstCall = mockSend.mock.calls[0][0];
    expect(firstCall.input.Select).toBe('COUNT');
  });
});
