import { ensureEntityMetadata, EntityMetadata } from '../dynamodb-orm.metadata-store';
import { FilterBuilder } from '../dynamodb-orm.filter-builder';

class TestEntity {}
const testMetadata: EntityMetadata = ensureEntityMetadata(TestEntity);

describe('FilterBuilder', () => {
  let builder: FilterBuilder;

  beforeEach(() => {
    builder = new FilterBuilder(testMetadata);
  });

  describe('equals operator', () => {
    it('should generate equality expression', () => {
      const result = builder.buildFilterExpressions({
        status: { equals: 'active' },
      });

      expect(result.FilterExpression).toBe('#attr0 = :val0');
      expect(result.ExpressionAttributeNames).toEqual({ '#attr0': 'status' });
      expect(result.ExpressionAttributeValues).toEqual({ ':val0': 'active' });
    });
  });

  describe('in operator', () => {
    it('should generate DynamoDB IN expression', () => {
      const result = builder.buildFilterExpressions({
        status: { in: ['active', 'pending', 'archived'] },
      });

      expect(result.FilterExpression).toBe(
        '#attr0 IN (:val0, :val1, :val2)',
      );
      expect(result.ExpressionAttributeNames).toEqual({ '#attr0': 'status' });
      expect(result.ExpressionAttributeValues).toEqual({
        ':val0': 'active',
        ':val1': 'pending',
        ':val2': 'archived',
      });
    });

    it('should skip in with empty array', () => {
      const result = builder.buildFilterExpressions({
        status: { in: [] },
      });

      // Empty array produces no filter expression
      expect(result.FilterExpression).toBeUndefined();
    });
  });

  describe('contains operator', () => {
    it('should generate contains() expression for a single value', () => {
      const result = builder.buildFilterExpressions({
        tags: { contains: 'important' },
      });

      expect(result.FilterExpression).toBe('contains(#attr0, :val0)');
      expect(result.ExpressionAttributeValues).toEqual({
        ':val0': 'important',
      });
    });

    it('should generate OR-joined contains() for an array of values', () => {
      const result = builder.buildFilterExpressions({
        tags: { contains: ['a', 'b'] },
      });

      expect(result.FilterExpression).toBe(
        '(contains(#attr0, :val0) OR contains(#attr0, :val1))',
      );
      expect(result.ExpressionAttributeValues).toEqual({
        ':val0': 'a',
        ':val1': 'b',
      });
    });
  });

  describe('exists operator', () => {
    it('should generate attribute_exists() when exists is true', () => {
      const result = builder.buildFilterExpressions({
        email: { exists: true },
      });

      expect(result.FilterExpression).toBe('attribute_exists(#attr0)');
      expect(result.ExpressionAttributeNames).toEqual({ '#attr0': 'email' });
      expect(result.ExpressionAttributeValues).toBeUndefined();
    });

    it('should generate attribute_not_exists() when exists is false', () => {
      const result = builder.buildFilterExpressions({
        email: { exists: false },
      });

      expect(result.FilterExpression).toBe('attribute_not_exists(#attr0)');
      expect(result.ExpressionAttributeNames).toEqual({ '#attr0': 'email' });
      expect(result.ExpressionAttributeValues).toBeUndefined();
    });
  });

  describe('beginsWith operator', () => {
    it('should generate begins_with() expression', () => {
      const result = builder.buildFilterExpressions({
        name: { beginsWith: 'Jo' },
      });

      expect(result.FilterExpression).toBe('begins_with(#attr0, :val0)');
      expect(result.ExpressionAttributeValues).toEqual({ ':val0': 'Jo' });
    });
  });

  describe('between operator', () => {
    it('should generate BETWEEN expression with two placeholders', () => {
      const result = builder.buildFilterExpressions({
        age: { between: [18, 65] },
      });

      expect(result.FilterExpression).toBe('#attr0 BETWEEN :val0 AND :val1');
      expect(result.ExpressionAttributeValues).toEqual({
        ':val0': 18,
        ':val1': 65,
      });
    });
  });

  describe('greaterThan operator', () => {
    it('should generate > expression', () => {
      const result = builder.buildFilterExpressions({
        score: { greaterThan: 90 },
      });

      expect(result.FilterExpression).toBe('#attr0 > :val0');
      expect(result.ExpressionAttributeValues).toEqual({ ':val0': 90 });
    });
  });

  describe('lessThan operator', () => {
    it('should generate < expression', () => {
      const result = builder.buildFilterExpressions({
        score: { lessThan: 50 },
      });

      expect(result.FilterExpression).toBe('#attr0 < :val0');
      expect(result.ExpressionAttributeValues).toEqual({ ':val0': 50 });
    });
  });

  describe('multiple conditions on same field (valueIndex collision fix)', () => {
    it('should produce unique placeholders for greaterThan and lessThan on same field', () => {
      const result = builder.buildFilterExpressions({
        score: { greaterThan: 10, lessThan: 100 },
      });

      expect(result.FilterExpression).toBe('#attr0 > :val0 AND #attr0 < :val1');
      expect(result.ExpressionAttributeValues).toEqual({
        ':val0': 10,
        ':val1': 100,
      });
    });

    it('should produce unique placeholders for equals and greaterThan on same field', () => {
      const result = builder.buildFilterExpressions({
        level: { equals: 'gold', greaterThan: 5 },
      });

      // Both conditions should have distinct :val placeholders
      const values = result.ExpressionAttributeValues!;
      const keys = Object.keys(values);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('multiple fields', () => {
    it('should join conditions across fields with AND', () => {
      const result = builder.buildFilterExpressions({
        status: { equals: 'active' },
        age: { greaterThan: 18 },
      });

      expect(result.FilterExpression).toBe('#attr0 = :val0 AND #attr1 > :val1');
      expect(result.ExpressionAttributeNames).toEqual({
        '#attr0': 'status',
        '#attr1': 'age',
      });
      expect(result.ExpressionAttributeValues).toEqual({
        ':val0': 'active',
        ':val1': 18,
      });
    });
  });

  describe('projection expressions', () => {
    it('should build projection expression with field placeholders', () => {
      const attributeNames: Record<string, string> = {};
      const projection = builder.buildProjectionExpression(
        ['name', 'email', 'age'],
        attributeNames,
      );

      expect(projection).toBe('#f0, #f1, #f2');
      expect(attributeNames).toEqual({
        '#f0': 'name',
        '#f1': 'email',
        '#f2': 'age',
      });
    });

    it('should return undefined for empty select', () => {
      const attributeNames: Record<string, string> = {};
      const projection = builder.buildProjectionExpression([], attributeNames);

      expect(projection).toBeUndefined();
    });

    it('should return undefined for undefined select', () => {
      const attributeNames: Record<string, string> = {};
      const projection = builder.buildProjectionExpression(
        undefined,
        attributeNames,
      );

      expect(projection).toBeUndefined();
    });
  });

  describe('no filters', () => {
    it('should return empty object when filters is undefined', () => {
      const result = builder.buildFilterExpressions(undefined);
      expect(result).toEqual({});
    });

    it('should return empty object when filters is empty', () => {
      const result = builder.buildFilterExpressions({});
      expect(result).toEqual({});
    });
  });
});
