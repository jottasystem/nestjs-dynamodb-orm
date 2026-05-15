import { TableManager } from '../dynamodb-orm.table-manager';
import { DynamoDBOrmInitializer } from '../dynamodb-orm.initializer';
import {
  ensureEntityMetadata,
} from '../dynamodb-orm.metadata-store';
import {
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';

// --- TableManager tests ---

jest.mock('@aws-sdk/client-dynamodb');

describe('TableManager', () => {

  let manager: TableManager;
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new TableManager();
    mockSend = jest.fn().mockResolvedValue({
      Table: { TableName: 'my-table', TableStatus: 'ACTIVE' },
    });
    (DynamoDBClient as unknown as jest.Mock).mockImplementation(() => ({
      send: mockSend,
    }));
  });

  it('parses region from ARN and creates DynamoDBClient for that region', async () => {
    const arn = 'arn:aws:dynamodb:eu-west-1:123456789012:table/my-table';
    await manager.validateTableArn(arn);

    expect(DynamoDBClient).toHaveBeenCalledWith({ region: 'eu-west-1' });
  });

  it('uses DescribeTableCommand with the table name from the ARN', async () => {
    const arn = 'arn:aws:dynamodb:us-east-1:123456789012:table/orders-table';
    await manager.validateTableArn(arn);

    expect(mockSend).toHaveBeenCalledTimes(1);
    // Verify DescribeTableCommand was constructed with the correct table name
    expect(DescribeTableCommand).toHaveBeenCalledWith({
      TableName: 'orders-table',
    });
  });

  it('throws when ARN is empty', async () => {
    await expect(manager.validateTableArn('')).rejects.toThrow(
      'Table ARN is required',
    );
  });

  it('throws when ARN has invalid format', async () => {
    await expect(
      manager.validateTableArn('not-a-valid-arn'),
    ).rejects.toThrow('Invalid DynamoDB table ARN format');
  });

  it('throws when ARN has no table name', async () => {
    await expect(
      manager.validateTableArn('arn:aws:dynamodb:us-east-1:123456789012:'),
    ).rejects.toThrow('Invalid table name in ARN');
  });

  it('throws when ARN has no region', async () => {
    await expect(
      manager.validateTableArn('arn:aws:dynamodb::123456789012:table/t'),
    ).rejects.toThrow('Invalid region in ARN');
  });

  it('throws descriptive error when table does not exist (ResourceNotFoundException)', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }),
    );

    await expect(
      manager.validateTableArn(
        'arn:aws:dynamodb:us-east-1:123456789012:table/missing',
      ),
    ).rejects.toThrow('does not exist or is not accessible');
  });

  it('throws descriptive error on AccessDeniedException', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );

    await expect(
      manager.validateTableArn(
        'arn:aws:dynamodb:us-east-1:123456789012:table/secret',
      ),
    ).rejects.toThrow('Access denied');
  });

  it('re-throws unknown errors', async () => {
    const unknownError = new Error('network failure');
    mockSend.mockRejectedValue(unknownError);

    await expect(
      manager.validateTableArn(
        'arn:aws:dynamodb:us-east-1:123456789012:table/t',
      ),
    ).rejects.toThrow('network failure');
  });
});

// --- DynamoDBOrmInitializer tests ---

describe('DynamoDBOrmInitializer', () => {
  let mockTableManager: { validateTableArn: jest.Mock };
  let mockLogger: { debug: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    mockTableManager = { validateTableArn: jest.fn().mockResolvedValue(undefined) };
    mockLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  it('calls validateTableArn with the correct ARN from entity metadata', async () => {
    class TestEntity {}
    const meta = ensureEntityMetadata(TestEntity);
    meta.tableArn = 'arn:aws:dynamodb:us-east-1:123456789012:table/test';
    meta.tableName = 'test';
    meta.region = 'us-east-1';

    const initializer = new DynamoDBOrmInitializer(
      [TestEntity],
      mockTableManager as any,
    );
    // Inject mock logger
    (initializer as any).logger = mockLogger;

    await initializer.onApplicationBootstrap();

    expect(mockTableManager.validateTableArn).toHaveBeenCalledWith(
      'arn:aws:dynamodb:us-east-1:123456789012:table/test',
      expect.objectContaining({ partitionKey: expect.any(String) }),
    );
  });

  it('logs warning and continues when entity has no metadata', async () => {
    class UnregisteredEntity {}
    // Do NOT register metadata for this entity

    const initializer = new DynamoDBOrmInitializer(
      [UnregisteredEntity],
      mockTableManager as any,
    );
    (initializer as any).logger = mockLogger;

    // Should not throw
    await initializer.onApplicationBootstrap();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No metadata found'),
      expect.objectContaining({ entity: 'UnregisteredEntity' }),
    );
    expect(mockTableManager.validateTableArn).not.toHaveBeenCalled();
  });

  it('uses getEntityMetadata (not prototype.constructor.metadata)', async () => {
    class AnotherEntity {}
    const meta = ensureEntityMetadata(AnotherEntity);
    meta.tableArn = 'arn:aws:dynamodb:eu-west-1:123456789012:table/another';
    meta.tableName = 'another';
    meta.region = 'eu-west-1';

    const initializer = new DynamoDBOrmInitializer(
      [AnotherEntity],
      mockTableManager as any,
    );
    (initializer as any).logger = mockLogger;

    await initializer.onApplicationBootstrap();

    // Verify it retrieved metadata via getEntityMetadata (the ARN matches)
    expect(mockTableManager.validateTableArn).toHaveBeenCalledWith(
      'arn:aws:dynamodb:eu-west-1:123456789012:table/another',
      expect.objectContaining({ partitionKey: expect.any(String) }),
    );
  });

  it('re-throws non-MetadataError errors', async () => {
    class FailEntity {}
    const meta = ensureEntityMetadata(FailEntity);
    meta.tableArn = 'arn:aws:dynamodb:us-east-1:123456789012:table/fail';
    meta.tableName = 'fail';
    meta.region = 'us-east-1';

    mockTableManager.validateTableArn.mockRejectedValue(
      new Error('connection timeout'),
    );

    const initializer = new DynamoDBOrmInitializer(
      [FailEntity],
      mockTableManager as any,
    );
    (initializer as any).logger = mockLogger;

    await expect(initializer.onApplicationBootstrap()).rejects.toThrow(
      'connection timeout',
    );
  });
});
