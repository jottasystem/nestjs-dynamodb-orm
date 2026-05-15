import * as fc from 'fast-check';
import { ensureEntityMetadata, EntityMetadata } from '../dynamodb-orm.metadata-store';
import { FilterBuilder } from '../dynamodb-orm.filter-builder';
import { QueryFilters } from '../dynamodb-orm.types';

class TestEntity {}
const testMetadata: EntityMetadata = ensureEntityMetadata(TestEntity);

/**
 * Property 3: FilterBuilder generates correct DynamoDB expressions per operator
 *
 * For any filter condition with operator type and value(s), the FilterBuilder
 * SHALL generate the correct DynamoDB expression syntax: `IN` for the `in`
 * operator (not `contains`), `contains()` for the `contains` operator,
 * `attribute_exists()` for `exists: true`, `attribute_not_exists()` for
 * `exists: false`, `begins_with()` for `beginsWith`, `BETWEEN` for `between`,
 * and comparison operators for `greaterThan`/`lessThan`.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 7.1, 7.2**
 */
describe('Property 3: FilterBuilder generates correct DynamoDB expressions per operator', () => {
  let builder: FilterBuilder;

  beforeEach(() => {
    builder = new FilterBuilder(testMetadata);
  });

  // Arbitrary for safe field names (valid identifiers)
  const fieldNameArb = fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s));

  // Arbitrary for primitive values used in filter conditions
  const primitiveValueArb = fc.oneof(
    fc.string({ minLength: 0, maxLength: 50 }),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
  );

  it('equals operator generates `= :valN` expression', () => {
    fc.assert(
      fc.property(fieldNameArb, primitiveValueArb, (field, value) => {
        const result = builder.buildFilterExpressions({
          [field]: { equals: value },
        });

        expect(result.FilterExpression).toMatch(/^#attr0 = :val\d+$/);
      }),
      { numRuns: 100 },
    );
  });

  it('in operator generates DynamoDB IN expression, not contains()', () => {
    fc.assert(
      fc.property(
        fieldNameArb,
        fc.array(primitiveValueArb, { minLength: 1, maxLength: 10 }),
        (field, values) => {
          const result = builder.buildFilterExpressions({
            [field]: { in: values },
          });

          // Must use IN syntax
          expect(result.FilterExpression).toContain('IN (');
          // Must NOT use contains()
          expect(result.FilterExpression).not.toContain('contains(');
          // Number of placeholders in the IN clause should match array length
          const inMatch = result.FilterExpression!.match(/IN \(([^)]+)\)/);
          expect(inMatch).toBeTruthy();
          const placeholders = inMatch![1].split(', ');
          expect(placeholders).toHaveLength(values.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('in operator with empty array produces no expression', () => {
    fc.assert(
      fc.property(fieldNameArb, (field) => {
        const result = builder.buildFilterExpressions({
          [field]: { in: [] },
        });

        expect(result.FilterExpression).toBeUndefined();
      }),
      { numRuns: 50 },
    );
  });

  it('contains operator generates contains() expression', () => {
    fc.assert(
      fc.property(fieldNameArb, primitiveValueArb, (field, value) => {
        const result = builder.buildFilterExpressions({
          [field]: { contains: value },
        });

        expect(result.FilterExpression).toMatch(
          /^contains\(#attr0, :val\d+\)$/,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('exists: true generates attribute_exists()', () => {
    fc.assert(
      fc.property(fieldNameArb, (field) => {
        const result = builder.buildFilterExpressions({
          [field]: { exists: true },
        });

        expect(result.FilterExpression).toBe('attribute_exists(#attr0)');
        // exists should not produce any value placeholders
        expect(result.ExpressionAttributeValues).toBeUndefined();
      }),
      { numRuns: 50 },
    );
  });

  it('exists: false generates attribute_not_exists()', () => {
    fc.assert(
      fc.property(fieldNameArb, (field) => {
        const result = builder.buildFilterExpressions({
          [field]: { exists: false },
        });

        expect(result.FilterExpression).toBe('attribute_not_exists(#attr0)');
        expect(result.ExpressionAttributeValues).toBeUndefined();
      }),
      { numRuns: 50 },
    );
  });

  it('beginsWith operator generates begins_with() expression', () => {
    fc.assert(
      fc.property(
        fieldNameArb,
        fc.string({ minLength: 1, maxLength: 30 }),
        (field, prefix) => {
          const result = builder.buildFilterExpressions({
            [field]: { beginsWith: prefix },
          });

          expect(result.FilterExpression).toMatch(
            /^begins_with\(#attr0, :val\d+\)$/,
          );
          // The value should be the prefix string
          const valKey = Object.keys(result.ExpressionAttributeValues!)[0];
          expect(result.ExpressionAttributeValues![valKey]).toBe(prefix);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('between operator generates BETWEEN expression with two placeholders', () => {
    fc.assert(
      fc.property(fieldNameArb, primitiveValueArb, primitiveValueArb, (field, val1, val2) => {
        const result = builder.buildFilterExpressions({
          [field]: { between: [val1, val2] },
        });

        expect(result.FilterExpression).toMatch(
          /^#attr0 BETWEEN :val\d+ AND :val\d+$/,
        );
        // Should have exactly 2 value placeholders
        const valKeys = Object.keys(result.ExpressionAttributeValues!);
        expect(valKeys).toHaveLength(2);
      }),
      { numRuns: 100 },
    );
  });

  it('greaterThan operator generates > expression', () => {
    fc.assert(
      fc.property(fieldNameArb, primitiveValueArb, (field, value) => {
        const result = builder.buildFilterExpressions({
          [field]: { greaterThan: value },
        });

        expect(result.FilterExpression).toMatch(/^#attr0 > :val\d+$/);
      }),
      { numRuns: 100 },
    );
  });

  it('lessThan operator generates < expression', () => {
    fc.assert(
      fc.property(fieldNameArb, primitiveValueArb, (field, value) => {
        const result = builder.buildFilterExpressions({
          [field]: { lessThan: value },
        });

        expect(result.FilterExpression).toMatch(/^#attr0 < :val\d+$/);
      }),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 4: FilterBuilder value placeholders are unique per condition
 *
 * For any set of filter conditions across any number of fields (including
 * multiple conditions on the same field), all value placeholders (`:valN`)
 * in the generated expression SHALL be unique, and each placeholder SHALL
 * map to its correct value in `ExpressionAttributeValues`.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3**
 */
describe('Property 4: FilterBuilder value placeholders are unique per condition', () => {
  let builder: FilterBuilder;

  beforeEach(() => {
    builder = new FilterBuilder(testMetadata);
  });

  // Arbitrary for safe field names
  const fieldNameArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s));

  const primitiveValueArb = fc.oneof(
    fc.string({ minLength: 0, maxLength: 30 }),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
  );

  // Arbitrary for a single QueryFilters object (one or more conditions on a field)
  const queryFiltersArb: fc.Arbitrary<QueryFilters> = fc.record(
    {
      equals: primitiveValueArb,
      greaterThan: primitiveValueArb,
      lessThan: primitiveValueArb,
      beginsWith: fc.string({ minLength: 1, maxLength: 20 }),
      between: fc.tuple(primitiveValueArb, primitiveValueArb) as fc.Arbitrary<[unknown, unknown]>,
      contains: primitiveValueArb,
      in: fc.array(primitiveValueArb, { minLength: 1, maxLength: 5 }),
      exists: fc.boolean(),
    },
    { requiredKeys: [] },
  );

  // Arbitrary for a filters map with 1-5 fields, each with random conditions
  const filtersArb = fc
    .array(fc.tuple(fieldNameArb, queryFiltersArb), { minLength: 1, maxLength: 5 })
    .map((entries) => {
      const filters: Record<string, QueryFilters> = {};
      for (const [field, conditions] of entries) {
        // Use unique field names by appending index if collision
        const key = filters[field] ? `${field}_dup` : field;
        filters[key] = conditions;
      }
      return filters;
    })
    // Ensure at least one condition produces a value placeholder
    .filter((filters) => {
      return Object.values(filters).some((conds) =>
        Object.entries(conds).some(
          ([k, v]) => v !== undefined && k !== 'exists',
        ),
      );
    });

  it('all :valN placeholders in ExpressionAttributeValues are unique', () => {
    fc.assert(
      fc.property(filtersArb, (filters) => {
        const result = builder.buildFilterExpressions(filters);

        if (!result.ExpressionAttributeValues) return; // no values to check

        const valKeys = Object.keys(result.ExpressionAttributeValues);
        // All keys must be unique (Set size equals array length)
        expect(new Set(valKeys).size).toBe(valKeys.length);
      }),
      { numRuns: 200 },
    );
  });

  it('every :valN placeholder in FilterExpression exists in ExpressionAttributeValues', () => {
    fc.assert(
      fc.property(filtersArb, (filters) => {
        const result = builder.buildFilterExpressions(filters);

        if (!result.FilterExpression) return;

        // Extract all :valN placeholders from the expression
        const placeholdersInExpr = result.FilterExpression.match(/:val\d+/g) || [];

        if (placeholdersInExpr.length === 0) return;

        expect(result.ExpressionAttributeValues).toBeDefined();

        for (const placeholder of placeholdersInExpr) {
          expect(result.ExpressionAttributeValues).toHaveProperty(placeholder);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('multiple conditions on the same field produce distinct placeholders', () => {
    fc.assert(
      fc.property(
        fieldNameArb,
        primitiveValueArb,
        primitiveValueArb,
        (field, val1, val2) => {
          const result = builder.buildFilterExpressions({
            [field]: { greaterThan: val1, lessThan: val2 },
          });

          expect(result.ExpressionAttributeValues).toBeDefined();
          const valKeys = Object.keys(result.ExpressionAttributeValues!);
          // Must have exactly 2 distinct placeholders
          expect(valKeys).toHaveLength(2);
          expect(new Set(valKeys).size).toBe(2);

          // Values must map correctly (one for greaterThan, one for lessThan)
          const valuesSet = new Set(Object.values(result.ExpressionAttributeValues!));
          // Both values should be present (unless val1 === val2, then set size is 1)
          if (val1 !== val2) {
            expect(valuesSet.size).toBe(2);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every ExpressionAttributeValues entry has a corresponding placeholder in FilterExpression', () => {
    fc.assert(
      fc.property(filtersArb, (filters) => {
        const result = builder.buildFilterExpressions(filters);

        if (!result.ExpressionAttributeValues || !result.FilterExpression) return;

        for (const key of Object.keys(result.ExpressionAttributeValues)) {
          expect(result.FilterExpression).toContain(key);
        }
      }),
      { numRuns: 200 },
    );
  });
});
