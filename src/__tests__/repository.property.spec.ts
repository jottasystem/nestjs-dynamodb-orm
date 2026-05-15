import * as fc from 'fast-check';
import { DynamoDBOrmRepository } from '../dynamodb-orm.repository';
import {
  ensureEntityMetadata,
  ensureHookMetadata,
} from '../dynamodb-orm.metadata-store';
import { ValidationError } from '../dynamodb-orm.errors';

// --- Test entity setup ---

class PropTestEntity {
  pk?: string;
  sk?: string;
  name?: string;
  status?: string;
}

const metadata = ensureEntityMetadata(PropTestEntity);
metadata.tableName = 'prop-test-table';
metadata.tableArn =
  'arn:aws:dynamodb:us-east-1:123456789012:table/prop-test-table';
metadata.region = 'us-east-1';
metadata.keys = { partitionKey: 'pk', sortKey: 'sk' };
metadata.attributes = { pk: {}, sk: {}, name: {}, status: {} };
metadata.indexes = [
  {
    type: 'GSI',
    name: 'gsi-email',
    attribute: 'email',
    partitionKey: 'email',
    sortKey: 'createdAt',
  },
  {
    type: 'LSI',
    name: 'lsi-status',
    attribute: 'status',
    sortKey: 'status',
  },
];
ensureHookMetadata(PropTestEntity);

const mockDocClient = { send: jest.fn() } as any;

function createRepo(): DynamoDBOrmRepository<PropTestEntity> {
  return new DynamoDBOrmRepository(PropTestEntity, mockDocClient);
}


/**
 * Property 1: ScanIndexForward is the logical inverse of descending
 *
 * For any value of `descending` in QueryOptions (true, false, or undefined),
 * the resulting `ScanIndexForward` parameter in the DynamoDB QueryCommand
 * SHALL equal `!descending`, where `undefined` is treated as `false`
 * (i.e., default ascending order yields `ScanIndexForward: true`).
 *
 * **Validates: Requirements 1.1, 1.2, 1.3**
 */
describe('Property 1: ScanIndexForward is the logical inverse of descending', () => {
  let repo: DynamoDBOrmRepository<PropTestEntity>;

  beforeEach(() => {
    repo = createRepo();
  });

  const descendingArb = fc.oneof(
    fc.constant(true),
    fc.constant(false),
    fc.constant(undefined),
  );

  it('ScanIndexForward equals !descending for any boolean or undefined descending value', () => {
    fc.assert(
      fc.property(descendingArb, (descending) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          descending,
        });
        const expected = !(descending ?? false);
        expect(params.ScanIndexForward).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('ScanIndexForward is true when options object is omitted entirely', () => {
    fc.assert(
      fc.property(fc.constant(undefined), () => {
        const params = (repo as any).buildQueryParams('pk-value');
        expect(params.ScanIndexForward).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('ScanIndexForward is true when options is an empty object (descending absent)', () => {
    fc.assert(
      fc.property(fc.constant({}), (options) => {
        const params = (repo as any).buildQueryParams('pk-value', options);
        expect(params.ScanIndexForward).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 5: GSI queries use the index's own key attributes
 *
 * For any entity with GSI metadata where the GSI has a different partition key
 * than the table, querying with that GSI's `indexName` SHALL use the GSI's
 * partition key in the `KeyConditionExpression`, not the table's primary keys.
 * When no `indexName` is provided, the table's primary keys SHALL be used.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
 */
describe('Property 5: GSI queries use the index\'s own key attributes', () => {
  let repo: DynamoDBOrmRepository<PropTestEntity>;

  beforeEach(() => {
    repo = createRepo();
  });

  // Arbitrary for partition key values
  const pkValueArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 30 }),
    fc.integer({ min: 1, max: 10000 }),
  );

  it('GSI query uses the GSI partition key, not the table partition key', () => {
    fc.assert(
      fc.property(pkValueArb, (pkValue) => {
        const params = (repo as any).buildQueryParams(pkValue, {
          indexName: 'gsi-email',
        });

        // GSI 'gsi-email' has partitionKey: 'email'
        expect(params.ExpressionAttributeNames['#pk']).toBe('email');
        expect(params.ExpressionAttributeValues[':pk']).toBe(pkValue);
        expect(params.IndexName).toBe('gsi-email');
      }),
      { numRuns: 100 },
    );
  });

  it('LSI query uses the table partition key (LSI shares table PK)', () => {
    fc.assert(
      fc.property(pkValueArb, (pkValue) => {
        const params = (repo as any).buildQueryParams(pkValue, {
          indexName: 'lsi-status',
        });

        // LSI shares the table's partition key 'pk'
        expect(params.ExpressionAttributeNames['#pk']).toBe('pk');
        expect(params.IndexName).toBe('lsi-status');
      }),
      { numRuns: 100 },
    );
  });

  it('no indexName uses the table primary keys', () => {
    fc.assert(
      fc.property(pkValueArb, (pkValue) => {
        const params = (repo as any).buildQueryParams(pkValue);

        expect(params.ExpressionAttributeNames['#pk']).toBe('pk');
        expect(params.ExpressionAttributeValues[':pk']).toBe(pkValue);
        expect(params.IndexName).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 10: Update params correctly classify undefined, null, and defined values
 *
 * For any entity with a mix of undefined, null, and defined non-key attribute
 * values, `buildUpdateParams` SHALL: skip undefined values entirely, generate
 * REMOVE clauses for null values, generate SET clauses for defined values, and
 * throw ValidationError when all non-key attributes are undefined.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3, 16.1, 16.2**
 */
describe('Property 10: Update params correctly classify undefined, null, and defined values', () => {
  let repo: DynamoDBOrmRepository<PropTestEntity>;

  beforeEach(() => {
    repo = createRepo();
  });

  // Arbitrary for attribute value classification: undefined (skip), null (REMOVE), or defined (SET)
  type AttrClassification = 'undefined' | 'null' | 'defined';
  const classificationArb = fc.constantFrom<AttrClassification>(
    'undefined',
    'null',
    'defined',
  );

  // Arbitrary for defined string values
  const definedValueArb = fc.string({ minLength: 1, maxLength: 20 });

  it('undefined values are skipped, null generates REMOVE, defined generates SET', () => {
    fc.assert(
      fc.property(
        classificationArb,
        classificationArb,
        definedValueArb,
        definedValueArb,
        (nameClass, statusClass, nameVal, statusVal) => {
          // At least one attribute must be non-undefined to avoid ValidationError
          if (nameClass === 'undefined' && statusClass === 'undefined') return;

          const entity = Object.assign(new PropTestEntity(), {
            pk: 'pk-1',
            sk: 'sk-1',
            name:
              nameClass === 'undefined'
                ? undefined
                : nameClass === 'null'
                  ? null
                  : nameVal,
            status:
              statusClass === 'undefined'
                ? undefined
                : statusClass === 'null'
                  ? null
                  : statusVal,
          });

          const params = (repo as any).buildUpdateParams(entity);

          // Count expected SET and REMOVE operations
          const expectedSets = [nameClass, statusClass].filter(
            (c) => c === 'defined',
          ).length;
          const expectedRemoves = [nameClass, statusClass].filter(
            (c) => c === 'null',
          ).length;

          if (expectedSets > 0) {
            expect(params.UpdateExpression).toContain('SET');
          }
          if (expectedRemoves > 0) {
            expect(params.UpdateExpression).toContain('REMOVE');
          }

          // Undefined values should not appear in expression attribute names
          const nameCount = Object.values(
            params.ExpressionAttributeNames,
          ).filter((v) => v === 'name').length;
          const statusCount = Object.values(
            params.ExpressionAttributeNames,
          ).filter((v) => v === 'status').length;

          if (nameClass === 'undefined') {
            expect(nameCount).toBe(0);
          } else {
            expect(nameCount).toBe(1);
          }

          if (statusClass === 'undefined') {
            expect(statusCount).toBe(0);
          } else {
            expect(statusCount).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('throws ValidationError when all non-key attributes are undefined', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (pkVal, skVal) => {
          const entity = Object.assign(new PropTestEntity(), {
            pk: pkVal,
            sk: skVal,
            // name and status are both undefined (not set)
          });

          expect(() => {
            (repo as any).buildUpdateParams(entity);
          }).toThrow(ValidationError);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 12: Index type detection uses exact name matching
 *
 * For any index metadata, `getPrimaryKeysToIgnore` SHALL identify the index
 * type by exact match on the index `name` field. An index named "gsi-email"
 * SHALL NOT match when the query specifies a different indexName like
 * "gsi-email-v2".
 *
 * **Validates: Requirements 17.1, 17.2, 17.3**
 */
describe('Property 12: Index type detection uses exact name matching', () => {
  let repo: DynamoDBOrmRepository<PropTestEntity>;

  beforeEach(() => {
    repo = createRepo();
  });

  it('exact GSI name match returns both pk and sk to ignore', () => {
    fc.assert(
      fc.property(fc.constant('gsi-email'), (indexName) => {
        const keys = (repo as any).getPrimaryKeysToIgnore(indexName);
        expect(keys).toContain('pk');
        expect(keys).toContain('sk');
      }),
      { numRuns: 100 },
    );
  });

  it('exact LSI name match returns only pk to ignore', () => {
    fc.assert(
      fc.property(fc.constant('lsi-status'), (indexName) => {
        const keys = (repo as any).getPrimaryKeysToIgnore(indexName);
        expect(keys).toContain('pk');
        expect(keys).not.toContain('sk');
      }),
      { numRuns: 100 },
    );
  });

  it('no index name returns both pk and sk to ignore', () => {
    fc.assert(
      fc.property(fc.constant(undefined), (indexName) => {
        const keys = (repo as any).getPrimaryKeysToIgnore(indexName);
        expect(keys).toContain('pk');
        expect(keys).toContain('sk');
      }),
      { numRuns: 100 },
    );
  });

  it('partial/extended name does NOT match existing index — throws MetadataError', () => {
    // Generate suffixes/prefixes that extend existing index names
    const nonMatchingNameArb = fc.oneof(
      // Extend existing GSI name
      fc.string({ minLength: 1, maxLength: 10 }).map(
        (suffix) => `gsi-email${suffix}`,
      ),
      // Extend existing LSI name
      fc.string({ minLength: 1, maxLength: 10 }).map(
        (suffix) => `lsi-status${suffix}`,
      ),
      // Completely random names that don't match
      fc.string({ minLength: 1, maxLength: 20 }).filter(
        (s) => s !== 'gsi-email' && s !== 'lsi-status',
      ),
    );

    fc.assert(
      fc.property(nonMatchingNameArb, (indexName) => {
        // When the index name doesn't exactly match any registered index,
        // getPrimaryKeysToIgnore should throw MetadataError (no silent fallback)
        expect(() => {
          (repo as any).getPrimaryKeysToIgnore(indexName);
        }).toThrow(/not found/);
      }),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 14: Sort key condition operators generate correct KeyConditionExpression
 *
 * For any valid operator and value, the generated `KeyConditionExpression`
 * SHALL include the sort key condition using the correct DynamoDB syntax
 * (not in `FilterExpression`).
 *
 * **Validates: Requirements 33.1, 33.2, 33.3**
 */
describe('Property 14: Sort key condition operators generate correct KeyConditionExpression', () => {
  let repo: DynamoDBOrmRepository<PropTestEntity>;

  beforeEach(() => {
    repo = createRepo();
  });

  const skValueArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.integer({ min: 0, max: 10000 }),
  );

  it('equals operator generates #sk = :sk', () => {
    fc.assert(
      fc.property(skValueArb, (skValue) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { equals: skValue },
        });

        expect(params.KeyConditionExpression).toContain('#sk = :sk');
        expect(params.ExpressionAttributeNames['#sk']).toBe('sk');
        expect(params.ExpressionAttributeValues[':sk']).toBe(skValue);
        expect(params.FilterExpression).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('beginsWith operator generates begins_with(#sk, :sk)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (prefix) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { beginsWith: prefix },
        });

        expect(params.KeyConditionExpression).toContain('begins_with(#sk, :sk)');
        expect(params.ExpressionAttributeNames['#sk']).toBe('sk');
        expect(params.ExpressionAttributeValues[':sk']).toBe(prefix);
      }),
      { numRuns: 100 },
    );
  });

  it('between operator generates #sk BETWEEN :sk_lo AND :sk_hi', () => {
    fc.assert(
      fc.property(skValueArb, skValueArb, (lo, hi) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { between: [lo, hi] },
        });

        expect(params.KeyConditionExpression).toContain('#sk BETWEEN :sk_lo AND :sk_hi');
        expect(params.ExpressionAttributeNames['#sk']).toBe('sk');
        expect(params.ExpressionAttributeValues[':sk_lo']).toBe(lo);
        expect(params.ExpressionAttributeValues[':sk_hi']).toBe(hi);
      }),
      { numRuns: 100 },
    );
  });

  it('greaterThan operator generates #sk > :sk', () => {
    fc.assert(
      fc.property(skValueArb, (skValue) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { greaterThan: skValue },
        });

        expect(params.KeyConditionExpression).toContain('#sk > :sk');
        expect(params.ExpressionAttributeValues[':sk']).toBe(skValue);
      }),
      { numRuns: 100 },
    );
  });

  it('lessThan operator generates #sk < :sk', () => {
    fc.assert(
      fc.property(skValueArb, (skValue) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { lessThan: skValue },
        });

        expect(params.KeyConditionExpression).toContain('#sk < :sk');
        expect(params.ExpressionAttributeValues[':sk']).toBe(skValue);
      }),
      { numRuns: 100 },
    );
  });

  it('greaterThanOrEqual operator generates #sk >= :sk', () => {
    fc.assert(
      fc.property(skValueArb, (skValue) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { greaterThanOrEqual: skValue },
        });

        expect(params.KeyConditionExpression).toContain('#sk >= :sk');
        expect(params.ExpressionAttributeValues[':sk']).toBe(skValue);
      }),
      { numRuns: 100 },
    );
  });

  it('lessThanOrEqual operator generates #sk <= :sk', () => {
    fc.assert(
      fc.property(skValueArb, (skValue) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { lessThanOrEqual: skValue },
        });

        expect(params.KeyConditionExpression).toContain('#sk <= :sk');
        expect(params.ExpressionAttributeValues[':sk']).toBe(skValue);
      }),
      { numRuns: 100 },
    );
  });

  it('all operators place sort key condition in KeyConditionExpression, not FilterExpression', () => {
    const operatorArb = fc.oneof(
      skValueArb.map((v) => ({ equals: v })),
      fc.string({ minLength: 1, maxLength: 10 }).map((v) => ({ beginsWith: v })),
      fc.tuple(skValueArb, skValueArb).map(([lo, hi]) => ({ between: [lo, hi] as [any, any] })),
      skValueArb.map((v) => ({ greaterThan: v })),
      skValueArb.map((v) => ({ lessThan: v })),
      skValueArb.map((v) => ({ greaterThanOrEqual: v })),
      skValueArb.map((v) => ({ lessThanOrEqual: v })),
    );

    fc.assert(
      fc.property(operatorArb, (sortKeyCondition) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition,
        });

        // KeyConditionExpression should contain more than just the pk condition
        expect(params.KeyConditionExpression).toContain('AND');
        // Sort key name should be mapped
        expect(params.ExpressionAttributeNames['#sk']).toBe('sk');
        // FilterExpression should not contain sort key logic
        expect(params.FilterExpression).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('sortKeyCondition with equals produces #sk = :sk', () => {
    fc.assert(
      fc.property(skValueArb, (skValue) => {
        const params = (repo as any).buildQueryParams('pk-value', {
          sortKeyCondition: { equals: skValue },
        });

        expect(params.KeyConditionExpression).toContain('#sk = :sk');
        expect(params.ExpressionAttributeValues[':sk']).toBe(skValue);
      }),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 11: Batch operations respect DynamoDB chunk size limits
 *
 * For any array of N keys, `batchGet` SHALL make `ceil(N/100)` calls each
 * with at most 100 keys. For any array of M items, `batchWrite` SHALL make
 * `ceil(M/25)` calls each with at most 25 items.
 *
 * **Validates: Requirements 8.1, 9.1**
 */
describe('Property 11: Batch operations respect DynamoDB chunk size limits', () => {
  let repo: DynamoDBOrmRepository<PropTestEntity>;
  const mockSend = mockDocClient.send as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = createRepo();
  });

  it('batchGet makes ceil(N/100) calls, each with at most 100 keys', async () => {
    // Generate N between 1 and 350
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 350 }),
        async (n) => {
          mockSend.mockReset();
          mockSend.mockResolvedValue({ Responses: { 'prop-test-table': [] } });

          const keys = Array.from({ length: n }, (_, i) => ({
            partitionKey: `pk-${i}`,
            sortKey: `sk-${i}`,
          }));

          await repo.batchGet(keys);

          const expectedCalls = Math.ceil(n / 100);
          expect(mockSend).toHaveBeenCalledTimes(expectedCalls);

          // Verify each call has at most 100 keys
          for (let i = 0; i < mockSend.mock.calls.length; i++) {
            const command = mockSend.mock.calls[i][0];
            const requestItems = command.input.RequestItems['prop-test-table'];
            expect(requestItems.Keys.length).toBeLessThanOrEqual(100);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it('batchWrite makes ceil(M/25) calls, each with at most 25 items', async () => {
    // Generate M between 1 and 100
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        async (m) => {
          mockSend.mockReset();
          mockSend.mockResolvedValue({});

          const items = Array.from({ length: m }, (_, i) => ({
            pk: `pk-${i}`,
            sk: `sk-${i}`,
            name: `name-${i}`,
          }));

          await repo.batchWrite(items);

          const expectedCalls = Math.ceil(m / 25);
          expect(mockSend).toHaveBeenCalledTimes(expectedCalls);

          // Verify each call has at most 25 items
          for (let i = 0; i < mockSend.mock.calls.length; i++) {
            const command = mockSend.mock.calls[i][0];
            const requestItems = command.input.RequestItems['prop-test-table'];
            expect(requestItems.length).toBeLessThanOrEqual(25);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
