import * as fc from 'fast-check';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createDocumentClient,
  clearDocumentClientCache,
} from '../dynamodb-orm.document-client';

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockImplementation(() => ({ mockClient: true })),
  },
}));

/**
 * Property 13: DocumentClient instances are cached per region
 *
 * For any sequence of `createDocumentClient` calls, calls with the same region
 * string SHALL return the same `DynamoDBDocumentClient` instance (referential
 * equality), and calls with different region strings SHALL return different
 * instances.
 *
 * **Validates: Requirements REQ-020**
 */
describe('Property 13: DocumentClient instances are cached per region', () => {
  beforeEach(() => {
    clearDocumentClientCache();
    // Reset the mock so each call to DynamoDBDocumentClient.from returns a new object
    (DynamoDBDocumentClient.from as jest.Mock).mockImplementation(() => ({
      mockClient: true,
      id: Math.random(),
    }));
  });

  // Arbitrary for valid AWS region strings
  const regionArb = fc.stringMatching(/^[a-z]{2}-[a-z]+-[1-9]$/);

  it('same region returns the same instance (referential equality)', () => {
    fc.assert(
      fc.property(regionArb, (region) => {
        clearDocumentClientCache();

        const metadata = {
          region,
          tableName: 'test-table',
          tableArn: `arn:aws:dynamodb:${region}:123456789012:table/test-table`,
          attributes: {},
          keys: { partitionKey: 'pk' },
          indexes: [],
        };

        const client1 = createDocumentClient(metadata);
        const client2 = createDocumentClient(metadata);

        expect(client1).toBe(client2);
      }),
      { numRuns: 100 },
    );
  });

  it('different regions return different instances', () => {
    // Generate two distinct regions using a tuple and filter
    const distinctRegionsArb = fc
      .tuple(regionArb, regionArb)
      .filter(([a, b]) => a !== b);

    fc.assert(
      fc.property(distinctRegionsArb, ([regionA, regionB]) => {
        clearDocumentClientCache();

        const metadataA = {
          region: regionA,
          tableName: 'table-a',
          tableArn: `arn:aws:dynamodb:${regionA}:123456789012:table/table-a`,
          attributes: {},
          keys: { partitionKey: 'pk' },
          indexes: [],
        };

        const metadataB = {
          region: regionB,
          tableName: 'table-b',
          tableArn: `arn:aws:dynamodb:${regionB}:123456789012:table/table-b`,
          attributes: {},
          keys: { partitionKey: 'pk' },
          indexes: [],
        };

        const clientA = createDocumentClient(metadataA);
        const clientB = createDocumentClient(metadataB);

        expect(clientA).not.toBe(clientB);
      }),
      { numRuns: 100 },
    );
  });

  it('multiple entities in the same region share one client instance', () => {
    fc.assert(
      fc.property(
        regionArb,
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 2, maxLength: 10 }),
        (region, tableNames) => {
          clearDocumentClientCache();

          const clients = tableNames.map((tableName) =>
            createDocumentClient({
              region,
              tableName,
              tableArn: `arn:aws:dynamodb:${region}:123456789012:table/${tableName}`,
              attributes: {},
              keys: { partitionKey: 'pk' },
              indexes: [],
            }),
          );

          // All clients for the same region should be the exact same instance
          const first = clients[0];
          for (const client of clients) {
            expect(client).toBe(first);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
