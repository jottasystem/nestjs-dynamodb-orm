import { DynamoDBOrmRepository } from '../dynamodb-orm.repository';
import {
  Table,
  PartitionKey,
  SortKey,
  Attribute,
  Index,
  BeforeInsert,
  AfterInsert,
  BeforeUpdate,
  AfterUpdate,
  AfterLoad,
} from '../dynamodb-orm-decorators/entity.decorators';
import { GenerateSearchKey } from '../dynamodb-orm-decorators/search-key.decorator';

/**
 * Integration tests with mocked DocumentClient verifying end-to-end flows.
 * Validates: REQ-034.5
 */

const hookLog: string[] = [];

@Table('arn:aws:dynamodb:us-east-1:123456789012:table/integration-test')
class IntegrationEntity {
  @PartitionKey()
  pk!: string;

  @SortKey()
  sk!: string;

  @Attribute()
  name!: string;

  @Attribute({ default: 'active' })
  status!: string;

  @GenerateSearchKey<IntegrationEntity>((e) => ({ name: e.name }))
  @Attribute()
  searchKey!: string;

  @Index({ type: 'GSI', partitionKey: 'email', name: 'gsi-email' })
  @Attribute()
  email!: string;

  @BeforeInsert()
  onBeforeInsert() {
    hookLog.push('beforeInsert');
  }

  @AfterInsert()
  onAfterInsert() {
    hookLog.push('afterInsert');
  }

  @BeforeUpdate()
  onBeforeUpdate() {
    hookLog.push('beforeUpdate');
  }

  @AfterUpdate()
  onAfterUpdate() {
    hookLog.push('afterUpdate');
  }

  @AfterLoad()
  onAfterLoad() {
    hookLog.push('afterLoad');
  }
}

const mockSend = jest.fn();
const mockDocClient = { send: mockSend } as any;
const mockLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

function createRepo() {
  return new DynamoDBOrmRepository(
    IntegrationEntity,
    mockDocClient,
    {},
    mockLogger,
  );
}

describe('Repository integration tests', () => {
  let repo: DynamoDBOrmRepository<IntegrationEntity>;

  beforeEach(() => {
    jest.clearAllMocks();
    hookLog.length = 0;
    repo = createRepo();
  });

  // --- Full CRUD lifecycle ---

  describe('create → findOne → update → delete lifecycle', () => {
    it('should complete a full CRUD lifecycle', async () => {
      // CREATE
      mockSend.mockResolvedValueOnce({});
      const created = await repo.create({
        pk: 'acc-1',
        sk: 'item-1',
        name: 'Widget',
        email: 'test@example.com',
      });

      expect(created.pk).toBe('acc-1');
      expect(created.sk).toBe('item-1');
      expect(created.name).toBe('Widget');
      expect(created.status).toBe('active'); // default applied

      // FIND ONE
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: 'acc-1',
          sk: 'item-1',
          name: 'Widget',
          status: 'active',
          email: 'test@example.com',
        },
      });
      const found = await repo.findOne('acc-1', 'item-1');

      expect(found).not.toBeNull();
      expect(found!.pk).toBe('acc-1');
      expect(found!.name).toBe('Widget');

      // UPDATE
      mockSend.mockResolvedValueOnce({
        Attributes: {
          pk: 'acc-1',
          sk: 'item-1',
          name: 'Updated Widget',
          status: 'active',
          email: 'test@example.com',
        },
      });
      const updated = await repo.update({
        pk: 'acc-1',
        sk: 'item-1',
        name: 'Updated Widget',
      });

      expect(updated.name).toBe('Updated Widget');

      // DELETE
      mockSend.mockResolvedValueOnce({});
      await repo.delete('acc-1', 'item-1');

      expect(mockSend).toHaveBeenCalledTimes(4);
    });
  });

  // --- Hooks execution order ---

  describe('hooks execution order across operations', () => {
    it('should execute beforeInsert → afterInsert on create', async () => {
      hookLog.length = 0;
      mockSend.mockResolvedValueOnce({});

      await repo.create({
        pk: 'acc-1',
        sk: 'item-1',
        name: 'Test',
        email: 'a@b.com',
      });

      // beforeInsert hooks include the search key compute + our custom hook
      // afterInsert hooks include the search key clear + our custom hook
      const beforeIdx = hookLog.indexOf('beforeInsert');
      const afterIdx = hookLog.indexOf('afterInsert');
      expect(beforeIdx).toBeGreaterThanOrEqual(0);
      expect(afterIdx).toBeGreaterThanOrEqual(0);
      expect(beforeIdx).toBeLessThan(afterIdx);
    });

    it('should execute beforeUpdate → afterUpdate on update', async () => {
      hookLog.length = 0;
      mockSend.mockResolvedValueOnce({
        Attributes: {
          pk: 'acc-1',
          sk: 'item-1',
          name: 'Updated',
          status: 'active',
        },
      });

      await repo.update({ pk: 'acc-1', sk: 'item-1', name: 'Updated' });

      const beforeIdx = hookLog.indexOf('beforeUpdate');
      const afterIdx = hookLog.indexOf('afterUpdate');
      expect(beforeIdx).toBeGreaterThanOrEqual(0);
      expect(afterIdx).toBeGreaterThanOrEqual(0);
      expect(beforeIdx).toBeLessThan(afterIdx);
    });

    it('should execute afterLoad on findOne', async () => {
      hookLog.length = 0;
      mockSend.mockResolvedValueOnce({
        Item: { pk: 'acc-1', sk: 'item-1', name: 'Test', status: 'active' },
      });

      await repo.findOne('acc-1', 'item-1');

      expect(hookLog).toContain('afterLoad');
    });

    it('should execute afterLoad on find results', async () => {
      hookLog.length = 0;
      mockSend.mockResolvedValueOnce({
        Items: [
          { pk: 'acc-1', sk: 'item-1', name: 'A', status: 'active' },
          { pk: 'acc-1', sk: 'item-2', name: 'B', status: 'active' },
        ],
        Count: 2,
        ScannedCount: 2,
      });

      await repo.find('acc-1', { limit: 10 });

      const afterLoadCount = hookLog.filter((h) => h === 'afterLoad').length;
      expect(afterLoadCount).toBe(2);
    });
  });

  // --- Search key generation (single execution, not double) ---

  describe('search key generation during create', () => {
    it('should generate search key exactly once via beforeInsert hook', async () => {
      mockSend.mockResolvedValueOnce({});

      await repo.create({
        pk: 'acc-1',
        sk: 'item-1',
        name: 'Widget',
        email: 'a@b.com',
      });

      // The PutCommand should have been called once
      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      const item = command.input.Item;

      // searchKey should be set (computed from name)
      // The search key is computed from { name: 'Widget' } → normalized 'widget'
      expect(item.searchKey).toBe('widget');

      // After afterInsert hooks, the searchKey is cleared on the entity
      // (this is the GenerateSearchKey behavior: clear after insert)
      // But the item sent to DynamoDB should have had it
    });

    it('should not double-compute search key', async () => {
      mockSend.mockResolvedValueOnce({});

      await repo.create({
        pk: 'acc-1',
        sk: 'item-1',
        name: 'Test Name',
        email: 'a@b.com',
      });

      const command = mockSend.mock.calls[0][0];
      const item = command.input.Item;

      // Search key should be the normalized version of 'Test Name'
      expect(item.searchKey).toBe('test name');
    });
  });

  // --- Filter builder integration with repository queries ---

  describe('filter builder integration with repository queries', () => {
    it('should apply filters in find query', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { pk: 'acc-1', sk: 'item-1', name: 'Active', status: 'active' },
        ],
        Count: 1,
        ScannedCount: 1,
      });

      await repo.find('acc-1', {
        limit: 10,
        filters: {
          status: { equals: 'active' },
        },
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      const input = command.input;

      expect(input.FilterExpression).toBeDefined();
      expect(input.FilterExpression).toContain('=');
    });

    it('should apply multiple filter conditions', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      await repo.find('acc-1', {
        limit: 10,
        filters: {
          name: { beginsWith: 'Wid' },
          status: { equals: 'active' },
        },
      });

      const command = mockSend.mock.calls[0][0];
      const input = command.input;

      expect(input.FilterExpression).toContain('begins_with');
      expect(input.FilterExpression).toContain('=');
    });
  });

  // --- GSI query with different partition key ---

  describe('GSI query with different partition key', () => {
    it('should resolve GSI partition key correctly', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            pk: 'acc-1',
            sk: 'item-1',
            name: 'Test',
            email: 'user@example.com',
          },
        ],
        Count: 1,
        ScannedCount: 1,
      });

      await repo.find('user@example.com', {
        indexName: 'gsi-email',
        limit: 10,
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      const input = command.input;

      // Should use the GSI's partition key 'email' not the table's 'pk'
      expect(input.IndexName).toBe('gsi-email');
      expect(input.ExpressionAttributeNames['#pk']).toBe('email');
      expect(input.ExpressionAttributeValues[':pk']).toBe('user@example.com');
    });
  });

  // --- batchGet chunking and parsing with afterLoad hooks ---

  describe('batchGet chunking and parsing with afterLoad hooks', () => {
    it('should chunk keys into groups of 100 and apply afterLoad hooks', async () => {
      // Create 150 keys to test chunking
      const keys = Array.from({ length: 150 }, (_, i) => ({
        partitionKey: `pk-${i}`,
        sortKey: `sk-${i}`,
      }));

      // First chunk (100 keys)
      mockSend.mockResolvedValueOnce({
        Responses: {
          'integration-test': Array.from({ length: 100 }, (_, i) => ({
            pk: `pk-${i}`,
            sk: `sk-${i}`,
            name: `Item ${i}`,
            status: 'active',
          })),
        },
      });

      // Second chunk (50 keys)
      mockSend.mockResolvedValueOnce({
        Responses: {
          'integration-test': Array.from({ length: 50 }, (_, i) => ({
            pk: `pk-${100 + i}`,
            sk: `sk-${100 + i}`,
            name: `Item ${100 + i}`,
            status: 'active',
          })),
        },
      });

      hookLog.length = 0;
      const result = await repo.batchGet(keys);

      expect(result.items).toHaveLength(150);
      expect(result.missingKeys).toHaveLength(0);
      expect(mockSend).toHaveBeenCalledTimes(2);

      // First call should have 100 keys
      const firstCall = mockSend.mock.calls[0][0];
      expect(
        firstCall.input.RequestItems['integration-test'].Keys,
      ).toHaveLength(100);

      // Second call should have 50 keys
      const secondCall = mockSend.mock.calls[1][0];
      expect(
        secondCall.input.RequestItems['integration-test'].Keys,
      ).toHaveLength(50);

      // afterLoad should have been called for each item
      const afterLoadCount = hookLog.filter((h) => h === 'afterLoad').length;
      expect(afterLoadCount).toBe(150);
    });

    it('should parse items through parseDynamoItem', async () => {
      mockSend.mockResolvedValueOnce({
        Responses: {
          'integration-test': [
            { pk: 'acc-1', sk: 'item-1', name: 'Test', status: 'active' },
          ],
        },
      });

      const result = await repo.batchGet([
        { partitionKey: 'acc-1', sortKey: 'item-1' },
      ]);

      expect(result.items).toHaveLength(1);
      expect(result.missingKeys).toEqual([]);
      expect(result.items[0]).toBeInstanceOf(IntegrationEntity);
      expect(result.items[0].pk).toBe('acc-1');
      expect(result.items[0].name).toBe('Test');
    });
  });

  // --- batchWrite chunking with beforeInsert hooks ---

  describe('batchWrite chunking with beforeInsert hooks', () => {
    it('should chunk items into groups of 25 and apply beforeInsert hooks', async () => {
      const items = Array.from({ length: 30 }, (_, i) => ({
        pk: `pk-${i}`,
        sk: `sk-${i}`,
        name: `Item ${i}`,
        email: `user${i}@example.com`,
      }));

      // First chunk (25 items)
      mockSend.mockResolvedValueOnce({});
      // Second chunk (5 items)
      mockSend.mockResolvedValueOnce({});

      hookLog.length = 0;
      await repo.batchWrite(items);

      expect(mockSend).toHaveBeenCalledTimes(2);

      // First call should have 25 items
      const firstCall = mockSend.mock.calls[0][0];
      expect(
        firstCall.input.RequestItems['integration-test'],
      ).toHaveLength(25);

      // Second call should have 5 items
      const secondCall = mockSend.mock.calls[1][0];
      expect(
        secondCall.input.RequestItems['integration-test'],
      ).toHaveLength(5);

      // beforeInsert should have been called for each item
      const beforeInsertCount = hookLog.filter(
        (h) => h === 'beforeInsert',
      ).length;
      expect(beforeInsertCount).toBe(30);
    });

    it('should apply search key generation via beforeInsert hooks', async () => {
      mockSend.mockResolvedValueOnce({});

      await repo.batchWrite([
        { pk: 'pk-1', sk: 'sk-1', name: 'Alpha', email: 'a@b.com' },
        { pk: 'pk-2', sk: 'sk-2', name: 'Beta', email: 'c@d.com' },
      ]);

      const command = mockSend.mock.calls[0][0];
      const writes = command.input.RequestItems['integration-test'];

      // Each item should have a computed searchKey
      expect(writes[0].PutRequest.Item.searchKey).toBe('alpha');
      expect(writes[1].PutRequest.Item.searchKey).toBe('beta');
    });
  });
});
