import * as fc from 'fast-check';
import {
  ensureEntityMetadata,
  getEntityMetadata,
} from '../dynamodb-orm.metadata-store';
import { Attribute } from '../dynamodb-orm-decorators/entity.decorators';
import { EntityHelpers } from '../dynamodb-orm.entity-helpers';
import { InvalidEntityError } from '../dynamodb-orm.errors';

/**
 * Property 2: Nullable validation via EntityHelpers.validateNonNullable
 *
 * For any entity class with N fields decorated with `@Attribute({ nullable: false })`,
 * the attribute metadata SHALL mark those fields with `nullable: false`, and calling
 * `EntityHelpers.validateNonNullable()` with any single nullable field set to `null`
 * or `undefined` SHALL throw an `InvalidEntityError` identifying that specific field.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.5**
 */
describe('Property 2: Nullable validation via EntityHelpers.validateNonNullable', () => {
  // Arbitrary for valid JS identifier field names (1–10 unique names)
  const fieldNameArb = fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s))
    .filter((s) => s !== '__proto__');

  const uniqueFieldNamesArb = fc
    .uniqueArray(fieldNameArb, { minLength: 1, maxLength: 10 })
    .filter((arr) => arr.length >= 1);

  it('stores nullable: false in attribute metadata for each decorated field', () => {
    fc.assert(
      fc.property(uniqueFieldNamesArb, (fieldNames) => {
        const className = `NullableEntity_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const TestClass = { [className]: class {} }[className];

        ensureEntityMetadata(TestClass);

        const target = TestClass.prototype;
        for (const fieldName of fieldNames) {
          Attribute({ nullable: false })(target, fieldName);
        }

        const metadata = getEntityMetadata(TestClass);

        for (const fieldName of fieldNames) {
          expect(metadata.attributes[fieldName].nullable).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('setting any single field to null throws InvalidEntityError for that specific field', () => {
    fc.assert(
      fc.property(
        uniqueFieldNamesArb,
        fc.nat().map((n) => n),
        (fieldNames, rawIndex) => {
          const className = `NullThrow_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const TestClass = { [className]: class {} }[className] as new () => any;

          ensureEntityMetadata(TestClass);

          const target = TestClass.prototype;
          for (const fieldName of fieldNames) {
            Attribute({ nullable: false })(target, fieldName);
          }

          const helpers = new EntityHelpers(TestClass);

          // Create an instance with all fields set to valid values
          const instance = new TestClass();
          for (const fieldName of fieldNames) {
            instance[fieldName] = 'valid_value';
          }

          // Pick one field to set to null
          const nullFieldIndex = rawIndex % fieldNames.length;
          const nullFieldName = fieldNames[nullFieldIndex];
          instance[nullFieldName] = null;

          // validateNonNullable should throw for the null field
          let thrownError: any;
          try {
            helpers.validateNonNullable(instance);
            throw new Error('Expected InvalidEntityError but no error was thrown');
          } catch (e) {
            thrownError = e;
          }

          expect(thrownError).toBeInstanceOf(InvalidEntityError);
          expect(thrownError.message).toContain(nullFieldName);
        },
      ),
      { numRuns: 100 },
    );
  });
});
