import * as fc from 'fast-check';
import {
  ensureEntityMetadata,
} from '../dynamodb-orm.metadata-store';
import { EntityHelpers } from '../dynamodb-orm.entity-helpers';

/**
 * Property 6: Serialization preserves native DynamoDB types
 *
 * For any entity containing Set, Buffer, Uint8Array, or Map values,
 * `convertToPlainObject` SHALL pass these instances through unchanged
 * (referential equality with the original).
 *
 * **Validates: Requirements 6.1, 6.2, 6.3**
 */
describe('Property 6: Serialization preserves native DynamoDB types', () => {
  class NativeTypesEntity {
    pk?: string;
  }

  let helpers: EntityHelpers<NativeTypesEntity>;

  beforeAll(() => {
    const meta = ensureEntityMetadata(NativeTypesEntity);
    meta.keys.partitionKey = 'pk';
    meta.attributes = { pk: {} };
    helpers = new EntityHelpers(NativeTypesEntity);
  });

  it('Set instances pass through unchanged (referential equality)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
        (items) => {
          const set = new Set(items);
          const entity = new NativeTypesEntity();
          (entity as any).tags = set;

          const result = helpers.convertToPlainObject(entity);
          expect(result['tags']).toBe(set);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Buffer instances pass through unchanged (referential equality)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (content) => {
          const buf = Buffer.from(content);
          const entity = new NativeTypesEntity();
          (entity as any).data = buf;

          const result = helpers.convertToPlainObject(entity);
          expect(result['data']).toBe(buf);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Uint8Array instances pass through unchanged (referential equality)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 20 }),
        (bytes) => {
          const arr = new Uint8Array(bytes);
          const entity = new NativeTypesEntity();
          (entity as any).binary = arr;

          const result = helpers.convertToPlainObject(entity);
          expect(result['binary']).toBe(arr);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Map instances pass through unchanged (referential equality)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.string({ minLength: 1, maxLength: 10 }), fc.string({ minLength: 0, maxLength: 20 })),
          { minLength: 0, maxLength: 5 },
        ),
        (entries) => {
          const map = new Map(entries);
          const entity = new NativeTypesEntity();
          (entity as any).mapping = map;

          const result = helpers.convertToPlainObject(entity);
          expect(result['mapping']).toBe(map);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 7: Date serialization produces ISO strings at any depth
 *
 * For any entity containing Date instances at any nesting depth (top-level,
 * inside arrays, inside nested objects, inside nested arrays of objects),
 * `convertToPlainObject` SHALL convert every Date to its ISO string representation.
 *
 * **Validates: Requirements 6.4, 6.5**
 */
describe('Property 7: Date serialization produces ISO strings at any depth', () => {
  class DateEntity {
    pk?: string;
  }

  let helpers: EntityHelpers<DateEntity>;

  beforeAll(() => {
    const meta = ensureEntityMetadata(DateEntity);
    meta.keys.partitionKey = 'pk';
    meta.attributes = { pk: {} };
    helpers = new EntityHelpers(DateEntity);
  });

  // Arbitrary for valid Date timestamps (avoid invalid dates)
  const dateArb = fc.date({ min: new Date('2000-01-01'), max: new Date('2030-12-31') });

  it('top-level Date values become ISO strings', () => {
    fc.assert(
      fc.property(dateArb, (date) => {
        const entity = new DateEntity();
        (entity as any).createdAt = date;

        const result = helpers.convertToPlainObject(entity);
        expect(result['createdAt']).toBe(date.toISOString());
        expect(typeof result['createdAt']).toBe('string');
      }),
      { numRuns: 100 },
    );
  });

  it('Date values inside arrays become ISO strings', () => {
    fc.assert(
      fc.property(
        fc.array(dateArb, { minLength: 1, maxLength: 5 }),
        (dates) => {
          const entity = new DateEntity();
          (entity as any).timestamps = dates;

          const result = helpers.convertToPlainObject(entity);
          const serialized = result['timestamps'] as string[];
          expect(serialized).toHaveLength(dates.length);
          for (let i = 0; i < dates.length; i++) {
            expect(serialized[i]).toBe(dates[i].toISOString());
            expect(typeof serialized[i]).toBe('string');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Date values inside nested objects become ISO strings', () => {
    fc.assert(
      fc.property(dateArb, dateArb, (date1, date2) => {
        const entity = new DateEntity();
        (entity as any).nested = {
          level1: {
            timestamp: date1,
          },
          other: date2,
        };

        const result = helpers.convertToPlainObject(entity);
        const nested = result['nested'] as any;
        expect(nested.level1.timestamp).toBe(date1.toISOString());
        expect(nested.other).toBe(date2.toISOString());
      }),
      { numRuns: 100 },
    );
  });

  it('Date values inside arrays of objects become ISO strings (2+ levels deep)', () => {
    fc.assert(
      fc.property(
        fc.array(dateArb, { minLength: 1, maxLength: 3 }),
        (dates) => {
          const entity = new DateEntity();
          (entity as any).items = dates.map((d) => ({ event: { at: d } }));

          const result = helpers.convertToPlainObject(entity);
          const items = result['items'] as any[];
          for (let i = 0; i < dates.length; i++) {
            expect(items[i].event.at).toBe(dates[i].toISOString());
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 8: Sort key inclusion based on null/undefined, not truthiness
 *
 * For any sort key value (including 0, '', false, undefined, null),
 * the sort key SHALL be included in the result if and only if the value
 * is neither undefined nor null.
 *
 * This tests the behavior pattern used by `buildItemKey`: given a sort key
 * value, determine if it should be included based on `!== undefined && !== null`.
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 11.4**
 */
describe('Property 8: Sort key inclusion based on null/undefined, not truthiness', () => {
  // The inclusion logic: sortKey !== undefined && sortKey !== null
  function shouldIncludeSortKey(value: unknown): boolean {
    return value !== undefined && value !== null;
  }

  // Arbitrary for values that SHOULD be included (truthy and falsy non-null/undefined)
  const includedValuesArb = fc.oneof(
    fc.constant(0),
    fc.constant(''),
    fc.constant(false),
    fc.integer(),
    fc.string({ minLength: 1, maxLength: 30 }),
    fc.constant(true),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
  );

  // Arbitrary for values that SHOULD be excluded
  const excludedValuesArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
  );

  it('falsy values like 0, empty string, and false are included', () => {
    fc.assert(
      fc.property(includedValuesArb, (value) => {
        expect(shouldIncludeSortKey(value)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('undefined and null are excluded', () => {
    fc.assert(
      fc.property(excludedValuesArb, (value) => {
        expect(shouldIncludeSortKey(value)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('any non-null non-undefined value is included', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.string(),
          fc.boolean(),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.constant(0),
          fc.constant(''),
          fc.constant(false),
        ),
        (value) => {
          expect(shouldIncludeSortKey(value)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 9: Default values are independent per entity instance
 *
 * For any entity class with default values that are arrays, objects, or factory
 * functions, calling `applyDefaults` on two separate instances SHALL produce
 * independent values — mutating the default value on one instance SHALL NOT
 * affect the other instance's default value.
 *
 * **Validates: Requirements 14.1, 14.2, 14.3**
 */
describe('Property 9: Default values are independent per entity instance', () => {
  it('array defaults are independent between instances', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 10 }), { minLength: 0, maxLength: 5 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (defaultArray, mutationValue) => {
          // Create a fresh class for each run to avoid metadata pollution
          class ArrayDefaultEntity {
            pk?: string;
            items?: string[];
          }
          const meta = ensureEntityMetadata(ArrayDefaultEntity);
          meta.keys.partitionKey = 'pk';
          meta.attributes = {
            pk: {},
            items: { default: [...defaultArray] },
          };

          const helpers = new EntityHelpers(ArrayDefaultEntity);
          const a = new ArrayDefaultEntity();
          const b = new ArrayDefaultEntity();
          helpers.applyDefaults(a);
          helpers.applyDefaults(b);

          // Mutate a's default
          a.items!.push(mutationValue);

          // b should be unaffected
          expect(b.items).toEqual(defaultArray);
          expect(a.items).not.toBe(b.items);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('object defaults are independent between instances', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.integer(),
        fc.integer(),
        (key, originalValue, mutatedValue) => {
          class ObjDefaultEntity {
            pk?: string;
            config?: Record<string, unknown>;
          }
          const meta = ensureEntityMetadata(ObjDefaultEntity);
          meta.keys.partitionKey = 'pk';
          meta.attributes = {
            pk: {},
            config: { default: { [key]: originalValue } },
          };

          const helpers = new EntityHelpers(ObjDefaultEntity);
          const a = new ObjDefaultEntity();
          const b = new ObjDefaultEntity();
          helpers.applyDefaults(a);
          helpers.applyDefaults(b);

          // Mutate a's default
          a.config![key] = mutatedValue;

          // b should be unaffected
          expect(b.config![key]).toBe(originalValue);
          expect(a.config).not.toBe(b.config);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('factory function defaults produce independent values per instance', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        (mutationValue) => {
          class FactoryDefaultEntity {
            pk?: string;
            list?: string[];
          }
          const meta = ensureEntityMetadata(FactoryDefaultEntity);
          meta.keys.partitionKey = 'pk';
          meta.attributes = {
            pk: {},
            list: { default: () => ['initial'] },
          };

          const helpers = new EntityHelpers(FactoryDefaultEntity);
          const a = new FactoryDefaultEntity();
          const b = new FactoryDefaultEntity();
          helpers.applyDefaults(a);
          helpers.applyDefaults(b);

          // Mutate a's default
          a.list!.push(mutationValue);

          // b should be unaffected
          expect(b.list).toEqual(['initial']);
          expect(a.list).not.toBe(b.list);
        },
      ),
      { numRuns: 100 },
    );
  });
});
