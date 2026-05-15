import { DynamoDBOrmRepository } from '../dynamodb-orm.repository';
import {
  ensureEntityMetadata,
  ensureHookMetadata,
} from '../dynamodb-orm.metadata-store';
import {
  ValidationError,
  ConditionFailedError,
  ThroughputExceededError,
} from '../dynamodb-orm.errors';

// --- Test entity setup ---

class TestEntity {
  pk?: string;
  sk?: string;
  name?: string;
  status?: string;
}

// Register metadata for TestEntity
const metadata = ensureEntityMetadata(TestEntity);
metadata.tableName = 'test-table';
metadata.tableArn =
  'arn:aws:dynamodb:us-east-1:123456789012:table/test-table';
metadata.region = 'us-east-1';
metadata.keys = { partitionKey: 'pk', sortKey: 'sk' };
metadata.attributes = { pk: {}, sk: {}, name: {}, status: {} };
metadata.indexes = [
  {
    type: 'GSI',
    name: 'gsi-email-index',
    attribute: 'email',
    partitionKey: 'email',
    sortKey: 'createdAt',
  },
  {
    type: 'LSI',
    name: 'lsi-status-index',
    attribute: 'status',
    sortKey: 'status',
  },
];

// Ensure hooks metadata exists
ensureHookMetadata(TestEntity);

// Mock DocumentClient
const mockSend = jest.fn();
const mockDocClient = { send: mockSend } as any;

function createRepo(): DynamoDBOrmRepository<TestEntity> {
  return new DynamoDBOrmRepository(TestEntity, mockDocClient);
}

describe('Repository core fixes', () => {
  let repo: DynamoDBOrmRepository<TestEntity>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = createRepo();
  });

  // --- ScanIndexForward (REQ-001) ---

  describe('ScanIndexForward logic', () => {
    it('should set ScanIndexForward to false when descending is true', () => {
      const params = (repo as any).buildQueryParams('pk-value', {
        descending: true,
      });
      expect(params.ScanIndexForward).toBe(false);
    });

    it('should set ScanIndexForward to true when descending is false', () => {
      const params = (repo as any).buildQueryParams('pk-value', {
        descending: false,
      });
      expect(params.ScanIndexForward).toBe(true);
    });

    it('should set ScanIndexForward to true when descending is undefined', () => {
      const params = (repo as any).buildQueryParams('pk-value', {});
      expect(params.ScanIndexForward).toBe(true);
    });

    it('should set ScanIndexForward to true when options is undefined', () => {
      const params = (repo as any).buildQueryParams('pk-value');
      expect(params.ScanIndexForward).toBe(true);
    });
  });

  // --- buildQueryParams with GSI (REQ-005) ---

  describe('buildQueryParams with GSI', () => {
    it('should use GSI partition key when indexName is a GSI', () => {
      const params = (repo as any).buildQueryParams('user@example.com', {
        indexName: 'gsi-email-index',
      });

      // The partition key in the expression should be the GSI's partition key
      expect(params.ExpressionAttributeNames['#pk']).toBe('email');
      expect(params.ExpressionAttributeValues[':pk']).toBe(
        'user@example.com',
      );
      expect(params.IndexName).toBe('gsi-email-index');
    });

    it('should use table primary keys when no indexName is provided', () => {
      const params = (repo as any).buildQueryParams('pk-value');

      expect(params.ExpressionAttributeNames['#pk']).toBe('pk');
      expect(params.ExpressionAttributeValues[':pk']).toBe('pk-value');
      expect(params.IndexName).toBeUndefined();
    });

    it('should use table partition key with LSI sort key for LSI index', () => {
      const params = (repo as any).buildQueryParams('pk-value', {
        indexName: 'lsi-status-index',
      });

      // LSI shares the table's partition key
      expect(params.ExpressionAttributeNames['#pk']).toBe('pk');
      expect(params.IndexName).toBe('lsi-status-index');
    });

    it('should throw MetadataError for unknown index name', () => {
      expect(() => {
        (repo as any).buildQueryParams('pk-value', {
          indexName: 'nonexistent-index',
        });
      }).toThrow(/not found/);
    });
  });

  // --- buildItemKey with falsy sort keys (REQ-011) ---

  describe('buildItemKey with falsy sort keys', () => {
    it('should include sort key when value is 0', () => {
      const key = (repo as any).buildItemKey('pk-value', 0);
      expect(key).toEqual({ pk: 'pk-value', sk: 0 });
    });

    it('should include sort key when value is empty string', () => {
      const key = (repo as any).buildItemKey('pk-value', '');
      expect(key).toEqual({ pk: 'pk-value', sk: '' });
    });

    it('should NOT include sort key when value is undefined', () => {
      const key = (repo as any).buildItemKey('pk-value', undefined);
      expect(key).toEqual({ pk: 'pk-value' });
      expect(key).not.toHaveProperty('sk');
    });

    it('should NOT include sort key when value is null', () => {
      const key = (repo as any).buildItemKey('pk-value', null);
      expect(key).toEqual({ pk: 'pk-value' });
      expect(key).not.toHaveProperty('sk');
    });

    it('should include sort key for normal string value', () => {
      const key = (repo as any).buildItemKey('pk-value', 'sort-123');
      expect(key).toEqual({ pk: 'pk-value', sk: 'sort-123' });
    });

    it('should include sort key for normal number value', () => {
      const key = (repo as any).buildItemKey('pk-value', 42);
      expect(key).toEqual({ pk: 'pk-value', sk: 42 });
    });
  });

  // --- buildUpdateParams (REQ-015, REQ-016) ---

  describe('buildUpdateParams', () => {
    it('should skip undefined values in update', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: 'Alice',
        status: undefined,
      });

      const params = (repo as any).buildUpdateParams(entity);

      // 'name' should be in SET, 'status' should be skipped
      expect(params.UpdateExpression).toContain('SET');
      expect(params.UpdateExpression).not.toContain('REMOVE');

      // Only 'name' should have a value placeholder
      const valueEntries = Object.values(
        params.ExpressionAttributeValues || {},
      );
      expect(valueEntries).toContain('Alice');
    });

    it('should generate REMOVE clause for null values', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: null,
      });

      const params = (repo as any).buildUpdateParams(entity);

      expect(params.UpdateExpression).toContain('REMOVE');
    });

    it('should throw ValidationError when all non-key attributes are undefined', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
      });

      expect(() => {
        (repo as any).buildUpdateParams(entity);
      }).toThrow(ValidationError);
    });

    it('should throw when rest is empty (only key attributes provided)', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
      });

      expect(() => {
        (repo as any).buildUpdateParams(entity);
      }).toThrow(/[Nn]o attributes to update/);
    });

    it('should handle mix of SET and REMOVE operations', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: 'Bob',
        status: null,
      });

      const params = (repo as any).buildUpdateParams(entity);

      expect(params.UpdateExpression).toContain('SET');
      expect(params.UpdateExpression).toContain('REMOVE');
    });

    it('should include correct Key in update params', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: 'Charlie',
      });

      const params = (repo as any).buildUpdateParams(entity);

      expect(params.Key).toEqual({ pk: 'pk-1', sk: 'sk-1' });
    });
  });

  // --- getPrimaryKeysToIgnore (REQ-017) ---

  describe('getPrimaryKeysToIgnore with exact name matching', () => {
    it('should return both pk and sk for GSI index', () => {
      const keys = (repo as any).getPrimaryKeysToIgnore('gsi-email-index');
      expect(keys).toContain('pk');
      expect(keys).toContain('sk');
    });

    it('should return only pk for LSI index', () => {
      const keys = (repo as any).getPrimaryKeysToIgnore('lsi-status-index');
      expect(keys).toContain('pk');
      expect(keys).not.toContain('sk');
    });

    it('should return both pk and sk when no index is provided', () => {
      const keys = (repo as any).getPrimaryKeysToIgnore(undefined);
      expect(keys).toContain('pk');
      expect(keys).toContain('sk');
    });

    it('should throw MetadataError for unknown index name (no silent fallback)', () => {
      // "gsi-email-index-v2" doesn't exist — should throw MetadataError
      expect(() => {
        (repo as any).getPrimaryKeysToIgnore('gsi-email-index-v2');
      }).toThrow(/not found/);
    });
  });
});


describe('Conditional expressions and error wrapping', () => {
  let repo: DynamoDBOrmRepository<TestEntity>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = createRepo();
  });

  // --- create with ensureNew (REQ-012) ---

  describe('create with ensureNew', () => {
    it('should add ConditionExpression when ensureNew is true', async () => {
      mockSend.mockResolvedValueOnce({});

      await repo.create({ pk: 'pk-1', sk: 'sk-1', name: 'Alice' }, { ensureNew: true });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.input.ConditionExpression).toBe('attribute_not_exists(#pk_cond)');
      expect(command.input.ExpressionAttributeNames).toEqual(
        expect.objectContaining({ '#pk_cond': 'pk' })
      );
    });

    it('should NOT add ConditionExpression when ensureNew is false', async () => {
      mockSend.mockResolvedValueOnce({});

      await repo.create({ pk: 'pk-1', sk: 'sk-1', name: 'Alice' }, { ensureNew: false });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.ConditionExpression).toBeUndefined();
    });

    it('should NOT add ConditionExpression when options are omitted', async () => {
      mockSend.mockResolvedValueOnce({});

      await repo.create({ pk: 'pk-1', sk: 'sk-1', name: 'Alice' });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.ConditionExpression).toBeUndefined();
    });
  });

  // --- update with ensureExists (REQ-013) ---

  describe('update with ensureExists', () => {
    it('should add ConditionExpression when ensureExists is true', async () => {
      mockSend.mockResolvedValueOnce({ Attributes: { pk: 'pk-1', sk: 'sk-1', name: 'Bob' } });

      await repo.update({ pk: 'pk-1', sk: 'sk-1', name: 'Bob' }, { ensureExists: true });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.input.ConditionExpression).toBe('attribute_exists(#pk_cond)');
      expect(command.input.ExpressionAttributeNames).toEqual(
        expect.objectContaining({ '#pk_cond': 'pk' })
      );
    });

    it('should NOT add ConditionExpression when ensureExists is false', async () => {
      mockSend.mockResolvedValueOnce({ Attributes: { pk: 'pk-1', sk: 'sk-1', name: 'Bob' } });

      await repo.update({ pk: 'pk-1', sk: 'sk-1', name: 'Bob' }, { ensureExists: false });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.ConditionExpression).toBeUndefined();
    });
  });

  // --- Error wrapping (REQ-019) ---

  describe('SDK error wrapping', () => {
    it('should wrap ConditionalCheckFailedException as ConditionFailedError', async () => {
      
      const sdkError = new Error('Condition failed');
      sdkError.name = 'ConditionalCheckFailedException';
      mockSend.mockRejectedValueOnce(sdkError);

      await expect(
        repo.create({ pk: 'pk-1', sk: 'sk-1', name: 'Alice' }, { ensureNew: true }),
      ).rejects.toThrow(ConditionFailedError);
    });

    it('should wrap ProvisionedThroughputExceededException as ThroughputExceededError', async () => {
      
      const sdkError = new Error('Throughput exceeded');
      sdkError.name = 'ProvisionedThroughputExceededException';
      mockSend.mockRejectedValueOnce(sdkError);

      await expect(
        repo.create({ pk: 'pk-1', sk: 'sk-1', name: 'Alice' }),
      ).rejects.toThrow(ThroughputExceededError);
    });

    it('ConditionFailedError includes entity name and operation context', async () => {
      
      const sdkError = new Error('Condition failed');
      sdkError.name = 'ConditionalCheckFailedException';
      mockSend.mockRejectedValueOnce(sdkError);

      try {
        await repo.create({ pk: 'pk-1', sk: 'sk-1', name: 'Alice' }, { ensureNew: true });
        fail('Expected ConditionFailedError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConditionFailedError);
        const ctx = (err as ConditionFailedError).context!;
        expect(ctx).toBeDefined();
        expect(ctx.entity).toBe('TestEntity');
        expect(ctx.operation).toBe('create');
      }
    });

    it('ThroughputExceededError includes entity name and operation context', async () => {
      
      const sdkError = new Error('Throughput exceeded');
      sdkError.name = 'ProvisionedThroughputExceededException';
      mockSend.mockRejectedValueOnce(sdkError);

      try {
        await repo.findOne('pk-1', 'sk-1');
        fail('Expected ThroughputExceededError');
      } catch (err) {
        expect(err).toBeInstanceOf(ThroughputExceededError);
        const ctx = (err as ThroughputExceededError).context!;
        expect(ctx).toBeDefined();
        expect(ctx.entity).toBe('TestEntity');
        expect(ctx.operation).toBe('findOne');
      }
    });
  });

  // --- nullHandling option (REQ-035) ---

  describe('nullHandling option on update', () => {
    it('should generate SET with null value when nullHandling is persist', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: null,
      });

      const params = (repo as any).buildUpdateParams(entity, { nullHandling: 'persist' });

      expect(params.UpdateExpression).toContain('SET');
      expect(params.UpdateExpression).not.toContain('REMOVE');
      // The value for the null attribute should be null in ExpressionAttributeValues
      const values = Object.values(params.ExpressionAttributeValues || {});
      expect(values).toContain(null);
    });

    it('should generate REMOVE clause when nullHandling is remove', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: null,
      });

      const params = (repo as any).buildUpdateParams(entity, { nullHandling: 'remove' });

      expect(params.UpdateExpression).toContain('REMOVE');
    });

    it('should default to REMOVE when nullHandling is omitted', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: null,
      });

      const params = (repo as any).buildUpdateParams(entity);

      expect(params.UpdateExpression).toContain('REMOVE');
    });

    it('should handle mix of null (persist) and defined values', () => {
      const entity = Object.assign(new TestEntity(), {
        pk: 'pk-1',
        sk: 'sk-1',
        name: null,
        status: 'active',
      });

      const params = (repo as any).buildUpdateParams(entity, { nullHandling: 'persist' });

      expect(params.UpdateExpression).toContain('SET');
      expect(params.UpdateExpression).not.toContain('REMOVE');
      // Both null and 'active' should be in SET
      const values = Object.values(params.ExpressionAttributeValues || {});
      expect(values).toContain(null);
      expect(values).toContain('active');
    });
  });
});
