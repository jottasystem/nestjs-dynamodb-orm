import * as fc from 'fast-check';
import {
  ensureEntityMetadata,
  ensureHookMetadata,
  getEntityMetadata,
  getHooksMetadata,
} from '../dynamodb-orm.metadata-store';

/**
 * Property 15: Metadata isolation between entity classes
 *
 * For any two distinct entity classes, decorating or modifying metadata on one
 * SHALL NOT affect the metadata of the other.
 *
 * **Validates: Requirements REQ-037**
 */
describe('Property 15: Metadata isolation between entity classes', () => {
  // Helper: dynamically create a fresh class with a unique name
  function createFreshClass(name: string): new () => unknown {
    const cls = { [name]: class {} }[name];
    return cls;
  }

  // Attribute names that collide with Object.prototype properties must be avoided
  // since metadata.attributes is a plain Record<string, AttributeMetadata>
  const prototypeKeys = new Set(Object.getOwnPropertyNames(Object.prototype));

  // Arbitrary for safe attribute names (valid identifiers, no prototype collisions)
  const safeAttrName = fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && !prototypeKeys.has(s));

  it('entity metadata mutations on class A do not affect class B', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => /^[a-zA-Z_]/.test(s)),
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => /^[a-zA-Z_]/.test(s)),
        fc.string({ minLength: 0, maxLength: 100 }), // tableName for A
        fc.string({ minLength: 0, maxLength: 50 }),  // region for A
        safeAttrName, // attribute name
        (nameA, nameB, tableNameA, regionA, attrName) => {
          // Create two completely independent classes
          const ClassA = createFreshClass(`A_${nameA}_${Date.now()}_${Math.random()}`);
          const ClassB = createFreshClass(`B_${nameB}_${Date.now()}_${Math.random()}`);

          // Register metadata for both
          const metaA = ensureEntityMetadata(ClassA);
          const metaB = ensureEntityMetadata(ClassB);

          // Snapshot B's initial state
          const initialTableNameB = metaB.tableName;
          const initialRegionB = metaB.region;
          const initialAttributeKeysB = Object.keys(metaB.attributes);

          // Mutate A's metadata
          metaA.tableName = tableNameA;
          metaA.region = regionA;
          metaA.attributes[attrName] = { hidden: true, nullable: false };

          // Assert B is unchanged
          expect(metaB.tableName).toBe(initialTableNameB);
          expect(metaB.region).toBe(initialRegionB);
          expect(Object.keys(metaB.attributes)).toEqual(initialAttributeKeysB);
          expect(metaB.attributes[attrName]).toBeUndefined();

          // Also verify via getEntityMetadata accessor
          const retrievedB = getEntityMetadata(ClassB);
          expect(retrievedB.tableName).toBe(initialTableNameB);
          expect(retrievedB.region).toBe(initialRegionB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('hooks metadata mutations on class A do not affect class B', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => /^[a-zA-Z_]/.test(s)),
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => /^[a-zA-Z_]/.test(s)),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }), // hook names
        (nameA, nameB, hookNames) => {
          const ClassA = createFreshClass(`HA_${nameA}_${Date.now()}_${Math.random()}`);
          const ClassB = createFreshClass(`HB_${nameB}_${Date.now()}_${Math.random()}`);

          const hooksA = ensureHookMetadata(ClassA);
          const hooksB = ensureHookMetadata(ClassB);

          // Snapshot B's initial hooks
          const initialBeforeInsertB = [...hooksB.beforeInsert];
          const initialBeforeUpdateB = [...hooksB.beforeUpdate];

          // Mutate A's hooks
          for (const hookName of hookNames) {
            hooksA.beforeInsert.push(hookName);
            hooksA.beforeUpdate.push(hookName);
          }

          // Assert B is unchanged
          expect(hooksB.beforeInsert).toEqual(initialBeforeInsertB);
          expect(hooksB.beforeUpdate).toEqual(initialBeforeUpdateB);

          // Also verify via getHooksMetadata accessor
          const retrievedB = getHooksMetadata(ClassB);
          expect(retrievedB.beforeInsert).toEqual(initialBeforeInsertB);
          expect(retrievedB.beforeUpdate).toEqual(initialBeforeUpdateB);
        },
      ),
      { numRuns: 100 },
    );
  });

});
