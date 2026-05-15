import 'reflect-metadata';
import { EntityHelpers } from '../dynamodb-orm.entity-helpers';
import {
  Table,
  PartitionKey,
  SortKey,
  Attribute,
} from '../dynamodb-orm-decorators/entity.decorators';
import { ValidationError } from '../dynamodb-orm.errors';

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/helpers-extras')
class HelpersEntity {
  @PartitionKey()
  pk!: string;

  @SortKey()
  sk!: string;

  @Attribute({ default: () => new Date('2024-01-01T00:00:00.000Z') })
  createdAt!: Date;

  @Attribute({ default: { foo: 'bar', nested: { x: 1 } } })
  cfg!: Record<string, unknown>;

  @Attribute({ default: ['a', 'b'] })
  tags!: string[];

  @Attribute({ type: 'date' })
  loadedAt!: Date;
}

// ---------------------------------------------------------------------------
// B4 — Cycle detection in convertToPlainObject
// ---------------------------------------------------------------------------
describe('B4: convertToPlainObject rejects circular references', () => {
  it('throws ValidationError instead of stack-overflowing', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const entity: any = { pk: 'a', sk: 'b' };
    entity.self = entity;
    expect(() => helpers.convertToPlainObject(entity)).toThrow(ValidationError);
  });

  it('detects cycles through arrays', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const entity: any = { pk: 'a', sk: 'b', items: [] as unknown[] };
    entity.items.push(entity.items);
    expect(() => helpers.convertToPlainObject(entity)).toThrow(ValidationError);
  });

  it('happily serialises deep but acyclic structures', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const result = helpers.convertToPlainObject({
      pk: 'a',
      sk: 'b',
      nested: { deep: { value: 'x' } },
    } as any);
    expect(result.nested).toEqual({ deep: { value: 'x' } });
  });
});

// ---------------------------------------------------------------------------
// B5 — applyDefaults preserves Date/factory semantics
// ---------------------------------------------------------------------------
describe('B5: applyDefaults preserves complex defaults', () => {
  it('invokes factory functions per call (no shared reference)', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const a: any = {};
    const b: any = {};
    helpers.applyDefaults(a);
    helpers.applyDefaults(b);
    expect(a.createdAt).toBeInstanceOf(Date);
    expect(b.createdAt).toBeInstanceOf(Date);
    expect(a.createdAt).not.toBe(b.createdAt); // distinct instances
  });

  it('deep-clones plain object defaults', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const a: any = {};
    const b: any = {};
    helpers.applyDefaults(a);
    helpers.applyDefaults(b);
    a.cfg.nested.x = 999;
    expect(b.cfg.nested.x).toBe(1); // not aliased
  });

  it('deep-clones array defaults', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const a: any = {};
    const b: any = {};
    helpers.applyDefaults(a);
    helpers.applyDefaults(b);
    a.tags.push('mutated');
    expect(b.tags).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// parseDynamoItem — Date deserialization
// ---------------------------------------------------------------------------
describe('parseDynamoItem date transformer', () => {
  it('converts string to Date for type:date attributes', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const result = helpers.parseDynamoItem({
      pk: 'a',
      sk: 'b',
      loadedAt: '2024-05-01T12:00:00.000Z',
    });
    expect(result.loadedAt).toBeInstanceOf(Date);
  });

  it('converts numeric epoch to Date for type:date attributes', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const epochMs = Date.UTC(2024, 0, 1);
    const result = helpers.parseDynamoItem({
      pk: 'a',
      sk: 'b',
      loadedAt: epochMs,
    });
    expect(result.loadedAt).toBeInstanceOf(Date);
    expect(result.loadedAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('passes through Date instances unchanged', () => {
    const helpers = new EntityHelpers(HelpersEntity);
    const d = new Date('2024-01-01');
    const result = helpers.parseDynamoItem({
      pk: 'a',
      sk: 'b',
      loadedAt: d,
    });
    expect(result.loadedAt).toBe(d);
  });
});
