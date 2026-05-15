# nestjs-dynamodb-orm

[![npm version](https://img.shields.io/npm/v/nestjs-dynamodb-orm.svg)](https://www.npmjs.com/package/nestjs-dynamodb-orm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Decorator-based DynamoDB ORM for NestJS, inspired by TypeORM. Built on top of `@aws-sdk/lib-dynamodb` with typed errors, lifecycle hooks, composite search keys and first-class GSI/LSI support.

## Features

- Decorator-driven entity modeling (`@Table`, `@PartitionKey`, `@SortKey`, `@Attribute`, `@Index`)
- Lifecycle hooks (`@BeforeInsert`, `@BeforeUpdate`, `@AfterInsert`, `@AfterUpdate`, `@AfterLoad`)
- Composite search keys via `@GenerateSearchKey`
- Typed error hierarchy (`ConditionFailedError`, `ThroughputExceededError`, `EntityNotFoundError`, …)
- Fluent filter builder for queries and scans, with generic type inference (`EntityFilters<T>`)
- NestJS integration with per-entity repositories injected via `@InjectRepository`
- Bootstrap validation that the live table's `KeySchema` matches the entity declaration
- First-class support for `count()`, `exists()`, `transactWrite()`, batch puts **and** deletes
- Custom client config via `forRoot()` — works with LocalStack, multi-account credentials, custom endpoints

## Installation

```bash
npm install nestjs-dynamodb-orm \
  @aws-sdk/client-dynamodb \
  @aws-sdk/lib-dynamodb \
  @nestjs/common \
  reflect-metadata
```

Enable decorator metadata in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Import `reflect-metadata` once at the entry point of your application (e.g. `main.ts`):

```ts
import 'reflect-metadata';
```

## Quick start

### 1. Define an entity

```ts
import {
  Table,
  PartitionKey,
  SortKey,
  Attribute,
  Index,
  BeforeInsert,
  BeforeUpdate,
  GenerateSearchKey,
} from 'nestjs-dynamodb-orm';
import KSUID from 'ksuid';

@Table(process.env.PRODUCT__ENTITY_NAME__DYNAMODB_TABLE_ARN!)
export class Product {
  @PartitionKey()
  accountId!: string;

  @SortKey()
  productId!: string;

  @Attribute()
  name!: string;

  @Attribute({ default: false })
  archived!: boolean;

  @Attribute({ default: [] })
  tags!: string[];

  @Attribute({ type: 'date' })
  createdAt!: Date;

  @Attribute({ type: 'date' })
  updatedAt!: Date;

  @GenerateSearchKey<Product>((p) => ({
    productId: p.productId,
    name: p.name,
    tags: p.tags,
  }))
  @Index({ type: 'LSI' })
  @Attribute()
  searchKey!: string;

  @BeforeInsert()
  onBeforeInsert() {
    this.productId ??= KSUID.randomSync().string;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  @BeforeUpdate()
  onBeforeUpdate() {
    this.updatedAt = new Date();
  }
}
```

### 2. Register the module

```ts
import { Module } from '@nestjs/common';
import { DynamoDBOrmModule } from 'nestjs-dynamodb-orm';
import { Product } from './product.entity';

@Module({
  imports: [
    // Optional — supply only if you need to customise the AWS client,
    // the logger, or repository defaults. Skip this if you're happy with
    // the standard AWS credentials chain.
    DynamoDBOrmModule.forRoot({
      clientOptions: {
        clientConfig: { endpoint: process.env.AWS_ENDPOINT }, // e.g. LocalStack
      },
      repositoryOptions: { verbose: false, maxRetries: 3 },
    }),
    DynamoDBOrmModule.forFeature([Product]),
  ],
  providers: [ProductService],
})
export class ProductModule {}
```

### 3. Inject the repository

```ts
import { Injectable } from '@nestjs/common';
import { DynamoDBOrmRepository, InjectRepository } from 'nestjs-dynamodb-orm';
import { Product } from './product.entity';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(Product)
    private readonly repo: DynamoDBOrmRepository<Product>,
  ) {}

  async list(accountId: string) {
    const { items, lastEvaluatedKey } = await this.repo.find(accountId, { limit: 50 });
    return { items, cursor: lastEvaluatedKey };
  }

  async create(product: Partial<Product>) {
    return this.repo.create(product);
  }
}
```

## Repository API

| Method | Returns | Notes |
| --- | --- | --- |
| `find(pk, options?)` | `{ items, lastEvaluatedKey }` | Auto-paginates up to `limit` post-filter items. |
| `scan(options?)` | `{ items, lastEvaluatedKey }` | Same pagination semantics as `find`. |
| `findOne(pk, sk?)` | `T \| null` | Single `GetItem`. |
| `exists(pk, sk?)` | `boolean` | Projection on the partition key — does not load the full item. |
| `count(pk, options?)` | `number` | Uses `Select: 'COUNT'`; respects filters and `maxScanned`. |
| `create(item, options?)` | `T` | Runs `applyDefaults → beforeInsert → validateNonNullable → put → afterInsert`. |
| `update(partial, options?)` | `T` | Only fields in `partial` are touched. `nullable: false` is enforced only on present fields. |
| `delete(pk, sk?)` | `void` | |
| `batchGet(keys)` | `{ items, missingKeys }` | Chunks 100/req, retries `UnprocessedKeys`, reports anything still missing. |
| `batchWrite({ puts?, deletes? })` | `void` | Chunks 25/req, retries `UnprocessedItems`. Per-item validation + hooks on puts. |
| `transactWrite(operations)` | `void` | Up to 100 ops; `TableName` is auto-filled when omitted. |

## Filters

`QueryOptions.filters` and `ScanOptions.filters` accept either the loose `Record<string, QueryFilters>` form or the strongly-typed `EntityFilters<T>` form:

```ts
const result = await repo.find('acc-1', {
  limit: 20,
  filters: {
    archived: { equals: false },
    tags: { contains: ['premium'] },
    createdAt: { greaterThan: new Date('2024-01-01').toISOString() },
  } satisfies EntityFilters<Product>,
});
```

Supported operators: `equals`, `notEquals`, `exists`, `beginsWith`, `between`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`, `contains`, `in`, `notIn`.

## Sort key conditions

`QueryOptions.sortKeyCondition` is one of:

```ts
{ equals: value }
{ beginsWith: 'prefix' }
{ between: [lo, hi] }
{ greaterThan: value }   { greaterThanOrEqual: value }
{ lessThan: value }      { lessThanOrEqual: value }
```

These compile to `KeyConditionExpression` (not `FilterExpression`), so they hit the index efficiently.

## Required AWS permissions

| Phase | Actions |
| --- | --- |
| Bootstrap validation | `dynamodb:DescribeTable` |
| Runtime | `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, `dynamodb:Query`, `dynamodb:Scan`, `dynamodb:BatchGetItem`, `dynamodb:BatchWriteItem` |
| Transactions | `dynamodb:TransactWriteItems` |

## Environment variables

Table ARNs are passed to `@Table(...)` and must follow:

```text
arn:aws:dynamodb:<region>:<account-id>:table/<table-name>
```

Convention for env var names: `<ENTITY>__ENTITY_NAME__DYNAMODB_TABLE_ARN`.

## Error handling

All errors extend `DynamoDBOrmError` and carry a structured `context` field:

| Error | Raised when |
| --- | --- |
| `ConditionFailedError` | `ConditionalCheckFailedException` or `TransactionCanceledException` |
| `EntityNotFoundError` | `ResourceNotFoundException` during a runtime operation |
| `InvalidEntityError` | `nullable: false` attribute is null/undefined on `create` or partial `update` |
| `ThroughputExceededError` | `ProvisionedThroughputExceededException` or `ThrottlingException` |
| `MetadataError` | Entity metadata missing or malformed |
| `ValidationError` | Repository-level validation failure, including `ValidationException` from the SDK |
| `DynamoDBOrmError` | Catch-all for unknown SDK errors |

## Schema validation at boot

`DynamoDBOrmInitializer` runs at `OnApplicationBootstrap`. For every entity registered via `forFeature`, it calls `DescribeTable` and asserts that the live `KeySchema` matches the entity's declared `@PartitionKey` and `@SortKey`. Mismatches fail fast with a descriptive error.

```text
Table products declares partition key 'pk' but entity declares 'accountId'
```

## Composite search keys

`@GenerateSearchKey` registers `BeforeInsert` and `BeforeUpdate` hooks that flatten a selection of fields into a single string (lower-cased, diacritics stripped, segments preserved by position). It also registers an `AfterLoad` hook that *removes* the property from loaded entities — the field is treated as an implementation detail of the index, not domain state.

```ts
computeSearchKeyFromFields({ name: 'João', city: undefined, tags: ['x'] })
// → "joao||x"
```

Use `beginsWith` on the indexed attribute to query against a prefix.

## Development

```bash
npm install
npm test              # unit + property-based + integration tests
npm run test:coverage
npm run lint
npm run build
```

The suite includes property-based tests (via `fast-check`) for decorators, repository, filter-builder, document-client, metadata-store and entity-helpers.

## Contributing

Issues and PRs are welcome. Please ensure tests pass and code is linted before submitting.

## License

[MIT](./LICENSE) © João Paulo
