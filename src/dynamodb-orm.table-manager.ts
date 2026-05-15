import {
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { parseTableArn } from './dynamodb-orm.metadata-store';

export interface TableKeys {
  partitionKey: string;
  sortKey?: string;
}

export class TableManager {
  /**
   * Validates that the given table ARN exists and (optionally) that its
   * key schema matches the entity's declared keys.
   *
   * @param tableArn - Fully-qualified DynamoDB table ARN.
   * @param expectedKeys - Optional. When provided, asserts that the live
   *   table's partition (and sort) keys match these names.
   * @throws Error when the ARN is malformed, the table is missing/inaccessible,
   *   or (when `expectedKeys` is given) the key schema diverges.
   */
  async validateTableArn(tableArn: string, expectedKeys?: TableKeys): Promise<void> {
    if (!tableArn) {
      throw new Error('Table ARN is required');
    }

    if (!tableArn.startsWith('arn:aws:dynamodb:')) {
      throw new Error(`Invalid DynamoDB table ARN format: ${tableArn}`);
    }

    const { tableName, region } = parseTableArn(tableArn);
    const client = new DynamoDBClient({ region });

    let description;
    try {
      description = await client.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : '';
      if (errorName === 'ResourceNotFoundException') {
        throw new Error(
          `Table specified in ARN does not exist or is not accessible: ${tableArn}`,
        );
      }
      if (errorName === 'AccessDeniedException') {
        throw new Error(
          `Access denied to table ARN: ${tableArn}. Required permissions: dynamodb:DescribeTable`,
        );
      }
      throw error;
    }

    if (!expectedKeys) return;

    const keySchema = description.Table?.KeySchema ?? [];
    const liveHash = keySchema.find((k) => k.KeyType === 'HASH')?.AttributeName;
    const liveRange = keySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName;

    if (liveHash && liveHash !== expectedKeys.partitionKey) {
      throw new Error(
        `Table ${tableName} declares partition key '${liveHash}' but entity declares '${expectedKeys.partitionKey}'`,
      );
    }

    if (expectedKeys.sortKey && liveRange && liveRange !== expectedKeys.sortKey) {
      throw new Error(
        `Table ${tableName} declares sort key '${liveRange}' but entity declares '${expectedKeys.sortKey}'`,
      );
    }

    if (!expectedKeys.sortKey && liveRange) {
      throw new Error(
        `Table ${tableName} has sort key '${liveRange}' but entity does not declare one`,
      );
    }

    if (expectedKeys.sortKey && !liveRange) {
      throw new Error(
        `Entity declares sort key '${expectedKeys.sortKey}' but table ${tableName} has none`,
      );
    }
  }
}
