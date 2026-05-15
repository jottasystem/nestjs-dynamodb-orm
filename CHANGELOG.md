# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — Unreleased

### Added

- Initial public release.
- Decorator-driven entity modeling (`@Table`, `@PartitionKey`, `@SortKey`, `@Attribute`, `@Index`).
- Lifecycle hooks: `@BeforeInsert`, `@BeforeUpdate`, `@AfterInsert`, `@AfterUpdate`, `@AfterLoad`.
- Composite, positional search keys via `@GenerateSearchKey` — empty segments preserved so `beginsWith` queries stay stable across missing fields.
- Typed error hierarchy (`DynamoDBOrmError` + 6 subclasses) with structured `context`.
- Fluent `FilterBuilder` with the full operator set: `equals`, `notEquals`, `exists`, `beginsWith`, `between`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`, `contains`, `in`, `notIn`. Unknown operators throw — never silently dropped.
- Generic `EntityFilters<T>` for typed filter maps with per-attribute inference.
- NestJS integration: `DynamoDBOrmModule.forRoot({ clientOptions, logger, repositoryOptions })` plus `forFeature([entities])`. `forFeature` uses optional injection so `forRoot` config is always honoured.
- Repository helpers: `find`, `findOne`, `scan`, `create`, `update`, `delete`, `exists`, `count`, `batchGet`, `batchWrite`, `transactWrite`.
- `update()` is safe with class-field initializers — only fields present in the partial (plus genuine hook additions) are touched.
- `batchGet` returns `{ items, missingKeys }` with collision-resistant key tracking.
- `batchWrite` supports both `puts` and `deletes`; retry matches unprocessed items by stable structural key (pk+sk), not `JSON.stringify`.
- `transactWrite()` shallow-clones operations — never mutates the caller's array.
- Bootstrap schema validation: `DescribeTable` checks that the live `KeySchema` matches the entity's declared keys (5 distinct failure modes).
- Custom document client support: pass a pre-built `DynamoDBDocumentClient` via `forRoot({ clientOptions: { client } })`, or supply `clientConfig` for endpoint/credentials. Custom configs are NOT cached.
- Logger DI through `LoggerInterface` (default: `@nestjs/common` `Logger`).

### Tests

- 367 tests across 20 suites — unit, integration with mocked SDK, property-based via `fast-check`, and a dedicated regression suite for every bug class addressed in pre-release hardening.
- 95% statement / 97% line / 96% function / 80% branch coverage across the public surface.
- `strict: true` in tsconfig.
