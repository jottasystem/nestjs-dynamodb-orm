import * as publicApi from '../index';

/**
 * Public API surface tests.
 *
 * Strategy:
 *  - Snapshot the exported keys so renames/additions show up in diff review
 *    rather than via "the lib stopped exporting X" issue on day 1.
 *  - Verify internal modules stay hidden (the actual encapsulation invariant).
 *  - Verify error classes WORK as advertised, not just "exist".
 *
 * We deliberately do NOT assert `typeof X === 'function'` for every decorator
 * — that proves nothing (any no-op `() => {}` would pass). Behaviour is
 * verified in `decorators.spec.ts`, `repository.spec.ts` and `regression.spec.ts`.
 */
describe('Public API surface', () => {
  describe('exported symbol set (snapshot)', () => {
    it('exports the curated set of symbols', () => {
      const keys = Object.keys(publicApi).sort();
      expect(keys).toMatchInlineSnapshot(`
        [
          "AfterInsert",
          "AfterLoad",
          "AfterUpdate",
          "Attribute",
          "BeforeInsert",
          "BeforeUpdate",
          "ConditionFailedError",
          "DYNAMODB_ORM_CLIENT_OPTIONS",
          "DYNAMODB_ORM_LOGGER",
          "DYNAMODB_ORM_REPOSITORY_OPTIONS",
          "DynamoDBOrmError",
          "DynamoDBOrmModule",
          "DynamoDBOrmRepository",
          "EntityNotFoundError",
          "GenerateSearchKey",
          "Index",
          "InjectRepository",
          "InvalidEntityError",
          "MetadataError",
          "PartitionKey",
          "SortKey",
          "Table",
          "TableManager",
          "ThroughputExceededError",
          "ValidationError",
          "computeSearchKeyFromFields",
          "createDocumentClient",
          "generateRepositoryToken",
          "normalizeSearchString",
        ]
      `);
    });
  });

  describe('error hierarchy is intact (real behaviour, not "isDefined")', () => {
    const errorClasses: Array<[keyof typeof publicApi, string]> = [
      ['MetadataError', 'MetadataError'],
      ['ConditionFailedError', 'ConditionFailedError'],
      ['ThroughputExceededError', 'ThroughputExceededError'],
      ['EntityNotFoundError', 'EntityNotFoundError'],
      ['InvalidEntityError', 'InvalidEntityError'],
      ['ValidationError', 'ValidationError'],
    ];

    it.each(errorClasses)(
      '%s extends DynamoDBOrmError and carries context',
      (key, expectedName) => {
        const Ctor = publicApi[key] as new (
          message: string,
          context?: Record<string, unknown>,
        ) => Error;
        const e = new Ctor('msg', { entity: 'Foo', operation: 'create' });
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(publicApi.DynamoDBOrmError);
        expect(e.name).toBe(expectedName);
        expect(e.message).toBe('msg');
        expect((e as InstanceType<typeof publicApi.DynamoDBOrmError>).context).toEqual({
          entity: 'Foo',
          operation: 'create',
        });
      },
    );
  });

  describe('internal symbols stay hidden (encapsulation invariant)', () => {
    const hiddenInternals = [
      'getEntityMetadata',
      'getHooksMetadata',
      'ensureEntityMetadata',
      'ensureHookMetadata',
      'EntityHelpers',
      'FilterBuilder',
      'clearDocumentClientCache',
      'DynamoDBOrmInitializer',
      'parseTableArn',
    ];

    it.each(hiddenInternals)('does NOT export %s', (name) => {
      expect((publicApi as Record<string, unknown>)[name]).toBeUndefined();
    });
  });
});
