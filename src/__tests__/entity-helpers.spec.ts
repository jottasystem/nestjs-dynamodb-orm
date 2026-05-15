import {
  ensureEntityMetadata,
  ensureHookMetadata,
} from '../dynamodb-orm.metadata-store';
import { EntityHelpers } from '../dynamodb-orm.entity-helpers';

describe('EntityHelpers', () => {
  // --- applyDefaults ---

  describe('applyDefaults', () => {
    it('should assign a primitive default directly', () => {
      class PrimDefaultEntity {
        pk?: string;
        status?: string;
      }
      const meta = ensureEntityMetadata(PrimDefaultEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = {
        pk: {},
        status: { default: 'active' },
      };

      const helpers = new EntityHelpers(PrimDefaultEntity);
      const entity = new PrimDefaultEntity();
      helpers.applyDefaults(entity);

      expect(entity.status).toBe('active');
    });

    it('should not overwrite an existing value with a default', () => {
      class NoOverwriteEntity {
        pk?: string;
        status?: string;
      }
      const meta = ensureEntityMetadata(NoOverwriteEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = {
        pk: {},
        status: { default: 'active' },
      };

      const helpers = new EntityHelpers(NoOverwriteEntity);
      const entity = new NoOverwriteEntity();
      entity.status = 'inactive';
      helpers.applyDefaults(entity);

      expect(entity.status).toBe('inactive');
    });

    it('should clone array defaults so instances are independent', () => {
      class ArrayDefaultEntity {
        pk?: string;
        tags?: string[];
      }
      const meta = ensureEntityMetadata(ArrayDefaultEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = {
        pk: {},
        tags: { default: [] },
      };

      const helpers = new EntityHelpers(ArrayDefaultEntity);
      const a = new ArrayDefaultEntity();
      const b = new ArrayDefaultEntity();
      helpers.applyDefaults(a);
      helpers.applyDefaults(b);

      // Mutating one should not affect the other
      a.tags!.push('mutated');
      expect(b.tags).toEqual([]);
    });

    it('should clone object defaults so instances are independent', () => {
      class ObjDefaultEntity {
        pk?: string;
        config?: Record<string, unknown>;
      }
      const meta = ensureEntityMetadata(ObjDefaultEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = {
        pk: {},
        config: { default: { retries: 3 } },
      };

      const helpers = new EntityHelpers(ObjDefaultEntity);
      const a = new ObjDefaultEntity();
      const b = new ObjDefaultEntity();
      helpers.applyDefaults(a);
      helpers.applyDefaults(b);

      a.config!['retries'] = 99;
      expect(b.config).toEqual({ retries: 3 });
    });

    it('should call factory function defaults to produce fresh values', () => {
      class FactoryDefaultEntity {
        pk?: string;
        items?: string[];
      }
      const meta = ensureEntityMetadata(FactoryDefaultEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = {
        pk: {},
        items: { default: () => ['initial'] },
      };

      const helpers = new EntityHelpers(FactoryDefaultEntity);
      const a = new FactoryDefaultEntity();
      const b = new FactoryDefaultEntity();
      helpers.applyDefaults(a);
      helpers.applyDefaults(b);

      a.items!.push('mutated');
      expect(b.items).toEqual(['initial']);
    });
  });

  // --- convertToPlainObject ---

  describe('convertToPlainObject', () => {
    class PlainEntity {
      pk?: string;
    }

    function makeHelpers() {
      const meta = ensureEntityMetadata(PlainEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = { pk: {} };
      return new EntityHelpers(PlainEntity);
    }

    it('should convert Date to ISO string', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      const date = new Date('2024-01-15T10:30:00.000Z');
      (entity as any).createdAt = date;

      const result = helpers.convertToPlainObject(entity);
      expect(result['createdAt']).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should pass through Set unchanged (referential equality)', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      const set = new Set(['a', 'b']);
      (entity as any).tags = set;

      const result = helpers.convertToPlainObject(entity);
      expect(result['tags']).toBe(set);
    });

    it('should pass through Buffer unchanged', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      const buf = Buffer.from('hello');
      (entity as any).data = buf;

      const result = helpers.convertToPlainObject(entity);
      expect(result['data']).toBe(buf);
    });

    it('should pass through Map unchanged', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      const map = new Map([['key', 'value']]);
      (entity as any).mapping = map;

      const result = helpers.convertToPlainObject(entity);
      expect(result['mapping']).toBe(map);
    });

    it('should convert Dates inside arrays to ISO strings', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      const d1 = new Date('2024-01-01T00:00:00.000Z');
      const d2 = new Date('2024-06-15T12:00:00.000Z');
      (entity as any).dates = [d1, d2];

      const result = helpers.convertToPlainObject(entity);
      expect(result['dates']).toEqual([
        '2024-01-01T00:00:00.000Z',
        '2024-06-15T12:00:00.000Z',
      ]);
    });

    it('should convert Dates inside nested objects', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      (entity as any).nested = {
        inner: {
          timestamp: new Date('2024-03-20T08:00:00.000Z'),
        },
      };

      const result = helpers.convertToPlainObject(entity);
      expect((result['nested'] as any).inner.timestamp).toBe(
        '2024-03-20T08:00:00.000Z',
      );
    });

    it('should preserve null values', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      (entity as any).field = null;

      const result = helpers.convertToPlainObject(entity);
      expect(result['field']).toBeNull();
    });

    it('should preserve undefined values', () => {
      const helpers = makeHelpers();
      const entity = new PlainEntity();
      (entity as any).field = undefined;

      const result = helpers.convertToPlainObject(entity);
      expect(result['field']).toBeUndefined();
    });
  });

  // --- parseDynamoItem ---

  describe('parseDynamoItem', () => {
    it('should filter hidden attributes', () => {
      class HiddenEntity {
        pk?: string;
        name?: string;
        secret?: string;
      }
      const meta = ensureEntityMetadata(HiddenEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = {
        pk: {},
        name: {},
        secret: { hidden: true },
      };

      const helpers = new EntityHelpers(HiddenEntity);
      const result = helpers.parseDynamoItem({
        pk: '123',
        name: 'Test',
        secret: 'hidden-value',
      });

      expect(result).toBeInstanceOf(HiddenEntity);
      expect(result.pk).toBe('123');
      expect(result.name).toBe('Test');
      expect(result.secret).toBeUndefined();
    });

    it('should return an instance of the entity class', () => {
      class InstanceEntity {
        pk?: string;
      }
      const meta = ensureEntityMetadata(InstanceEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = { pk: {} };

      const helpers = new EntityHelpers(InstanceEntity);
      const result = helpers.parseDynamoItem({ pk: 'abc' });

      expect(result).toBeInstanceOf(InstanceEntity);
    });
  });

  // --- applyHooks ---

  describe('applyHooks', () => {
    it('should execute hooks in registration order', async () => {
      const callOrder: string[] = [];

      class HookEntity {
        pk?: string;
        hookA() { callOrder.push('hookA'); }
        hookB() { callOrder.push('hookB'); }
      }
      const meta = ensureEntityMetadata(HookEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = { pk: {} };

      const hooks = ensureHookMetadata(HookEntity);
      hooks.afterLoad = ['hookA', 'hookB'];

      const helpers = new EntityHelpers(HookEntity);
      const entity = new HookEntity();
      await helpers.applyHooks(entity, 'afterLoad');

      expect(callOrder).toEqual(['hookA', 'hookB']);
    });

    it('should do nothing when no hooks are registered for the type', async () => {
      class NoHookEntity {
        pk?: string;
      }
      const meta = ensureEntityMetadata(NoHookEntity);
      meta.keys.partitionKey = 'pk';
      meta.attributes = { pk: {} };

      const helpers = new EntityHelpers(NoHookEntity);
      const entity = new NoHookEntity();

      // Should not throw
      await helpers.applyHooks(entity, 'beforeInsert');
    });
  });
});
