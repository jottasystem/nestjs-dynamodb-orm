import {
  getEntityMetadata,
  getHooksMetadata,
  ensureEntityMetadata,
  ensureHookMetadata,
  generateRepositoryToken,
} from '../dynamodb-orm.metadata-store';
import { MetadataError } from '../dynamodb-orm.errors';

describe('MetadataStore', () => {
  // Each test uses fresh classes to avoid cross-test interference
  // (module-level WeakMaps/Maps persist across tests in the same module)

  describe('getEntityMetadata', () => {
    it('should throw MetadataError for an unregistered entity', () => {
      class UnregisteredEntity {}

      expect(() => getEntityMetadata(UnregisteredEntity)).toThrow(MetadataError);
      expect(() => getEntityMetadata(UnregisteredEntity)).toThrow(
        /No metadata registered for entity 'UnregisteredEntity'/,
      );
    });

    it('should include entity name in error context', () => {
      class AnotherUnregistered {}

      try {
        getEntityMetadata(AnotherUnregistered);
        fail('Expected MetadataError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MetadataError);
        expect((error as MetadataError).context).toEqual({
          entity: 'AnotherUnregistered',
        });
      }
    });
  });

  describe('getHooksMetadata', () => {
    it('should return safe defaults for an unregistered entity', () => {
      class NoHooksEntity {}

      const hooks = getHooksMetadata(NoHooksEntity);
      expect(hooks).toEqual({
        beforeInsert: [],
        beforeUpdate: [],
        afterInsert: [],
        afterUpdate: [],
        afterLoad: [],
      });
    });

  });

  describe('ensureEntityMetadata', () => {
    it('should create and return metadata for a new entity (Function path)', () => {
      class NewEntityFunc {}

      const metadata = ensureEntityMetadata(NewEntityFunc);
      expect(metadata).toBeDefined();
      expect(metadata.attributes).toEqual({});
      expect(metadata.keys).toEqual({ partitionKey: '' });
      expect(metadata.indexes).toEqual([]);
      expect(metadata.tableName).toBe('');
      expect(metadata.tableArn).toBe('');
      expect(metadata.region).toBe('');
    });

    it('should return the same metadata object on subsequent calls (Function path)', () => {
      class StableEntityFunc {}

      const first = ensureEntityMetadata(StableEntityFunc);
      const second = ensureEntityMetadata(StableEntityFunc);
      expect(first).toBe(second);
    });

    it('should only accept Function, not string', () => {
      // ensureEntityMetadata no longer accepts strings — WeakMap rejects non-object keys
      expect(() => ensureEntityMetadata('StringBasedEntity' as any)).toThrow();
    });
  });

  describe('ensureHookMetadata', () => {
    it('should create and return hooks for a new entity (Function path)', () => {
      class NewHookEntityFunc {}

      const hooks = ensureHookMetadata(NewHookEntityFunc);
      expect(hooks).toEqual({
        beforeInsert: [],
        beforeUpdate: [],
        afterInsert: [],
        afterUpdate: [],
        afterLoad: [],
      });
    });

    it('should return the same hooks object on subsequent calls (Function path)', () => {
      class StableHookFunc {}

      const first = ensureHookMetadata(StableHookFunc);
      const second = ensureHookMetadata(StableHookFunc);
      expect(first).toBe(second);
    });

    it('should only accept Function, not string', () => {
      // ensureHookMetadata no longer accepts strings — WeakMap rejects non-object keys
      expect(() => ensureHookMetadata('StringHookEntity' as any)).toThrow();
    });
  });

  describe('generateRepositoryToken', () => {
    it('should return a stable token for the same constructor', () => {
      class TokenEntityStable {}

      const token1 = generateRepositoryToken(TokenEntityStable);
      const token2 = generateRepositoryToken(TokenEntityStable);
      expect(token1).toBe(token2);
    });

    it('should return different tokens for different constructors', () => {
      class TokenEntityA {}
      class TokenEntityB {}

      const tokenA = generateRepositoryToken(TokenEntityA);
      const tokenB = generateRepositoryToken(TokenEntityB);
      expect(tokenA).not.toBe(tokenB);
    });

    it('should include the entity name in the token', () => {
      class NamedTokenEntity {}

      const token = generateRepositoryToken(NamedTokenEntity);
      expect(token).toContain('NamedTokenEntity');
    });
  });

  describe('WeakMap isolation', () => {
    it('should give two distinct classes independent metadata', () => {
      class IsolatedA {}
      class IsolatedB {}

      const metaA = ensureEntityMetadata(IsolatedA);
      const metaB = ensureEntityMetadata(IsolatedB);

      // Mutate A's metadata
      metaA.tableName = 'table-a';
      metaA.region = 'us-east-1';
      metaA.attributes['fieldA'] = { hidden: true };

      // B should be unaffected
      expect(metaB.tableName).toBe('');
      expect(metaB.region).toBe('');
      expect(metaB.attributes).toEqual({});
    });

    it('should give two distinct classes independent hooks metadata', () => {
      class HookIsolatedA {}
      class HookIsolatedB {}

      const hooksA = ensureHookMetadata(HookIsolatedA);
      const hooksB = ensureHookMetadata(HookIsolatedB);

      // Mutate A's hooks
      hooksA.beforeInsert.push('hookA');

      // B should be unaffected
      expect(hooksB.beforeInsert).toEqual([]);
    });
  });

  describe('constructor-only lookup', () => {
    it('should make metadata accessible via constructor after registration', () => {
      class ConstructorRegEntity {}

      const metaFromConstructor = ensureEntityMetadata(ConstructorRegEntity);
      metaFromConstructor.tableName = 'constructor-table';

      // getEntityMetadata should find it via the constructor (WeakMap)
      const retrieved = getEntityMetadata(ConstructorRegEntity);
      expect(retrieved).toBe(metaFromConstructor);
      expect(retrieved.tableName).toBe('constructor-table');
    });

    it('should make hooks accessible via constructor after registration', () => {
      class ConstructorRegHookEntity {}

      const hooksFromConstructor = ensureHookMetadata(ConstructorRegHookEntity);
      hooksFromConstructor.beforeInsert.push('myHook');

      // getHooksMetadata should find it via the constructor (WeakMap)
      const retrieved = getHooksMetadata(ConstructorRegHookEntity);
      expect(retrieved).toBe(hooksFromConstructor);
      expect(retrieved.beforeInsert).toContain('myHook');
    });

    it('should NOT allow same-name classes to collide', () => {
      // Create two classes with the same name via factory
      const ClassA = { MyEntity: class {} }['MyEntity'];
      const ClassB = { MyEntity: class {} }['MyEntity'];

      expect(ClassA.name).toBe(ClassB.name); // same name

      const metaA = ensureEntityMetadata(ClassA);
      metaA.tableName = 'table-a';

      // ClassB has no metadata registered — should throw
      expect(() => getEntityMetadata(ClassB)).toThrow(/No metadata registered/);
    });
  });
});
