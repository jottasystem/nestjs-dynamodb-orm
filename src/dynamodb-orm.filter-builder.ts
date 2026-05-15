import { QueryFilters } from './dynamodb-orm.types';
import { EntityMetadata } from './dynamodb-orm.metadata-store';
import { ValidationError } from './dynamodb-orm.errors';

// Expression placeholders
const EXPRESSION_PLACEHOLDERS = {
  ATTRIBUTE_PREFIX: '#attr',
  VALUE_PREFIX: ':val',
  FIELD_PREFIX: '#f',
} as const;

interface FilterResult {
  FilterExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

export class FilterBuilder {
  constructor(private readonly metadata: EntityMetadata) {}

  buildFilterExpressions(
    filters?: Record<string, QueryFilters>,
    primaryKeys?: string[]
  ): FilterResult {
    if (!filters) return {};

    const filterExpressions: string[] = [];
    const attributeNames: Record<string, string> = {};
    const attributeValues: Record<string, unknown> = {};
    const indexes = this.metadata.indexes || [];
    const counter = { value: 0 };
    let fieldIndex = 0;

    for (const [field, conditions] of Object.entries(filters)) {
      const isIndexField = indexes.some((idx) => idx.attribute === field);
      if (!isIndexField && primaryKeys?.includes(field)) {
        continue;
      }

      const fieldExpressions = this.buildFieldExpressions(
        field,
        conditions,
        fieldIndex,
        counter,
        attributeNames,
        attributeValues
      );

      if (fieldExpressions.length > 0) {
        filterExpressions.push(fieldExpressions.join(' AND '));
      }
      fieldIndex++;
    }

    return this.buildResult(filterExpressions, attributeNames, attributeValues);
  }

  buildProjectionExpression(
    select: string[] | undefined,
    attributeNames: Record<string, string>
  ): string | undefined {
    if (!select?.length) return undefined;

    return select
      .map((field, i) => {
        const fieldKey = `${EXPRESSION_PLACEHOLDERS.FIELD_PREFIX}${i}`;
        attributeNames[fieldKey] = field;
        return fieldKey;
      })
      .join(', ');
  }

  private buildFieldExpressions(
    field: string,
    conditions: QueryFilters,
    fieldIndex: number,
    counter: { value: number },
    attributeNames: Record<string, string>,
    attributeValues: Record<string, unknown>
  ): string[] {
    const attrName = `${EXPRESSION_PLACEHOLDERS.ATTRIBUTE_PREFIX}${fieldIndex}`;
    attributeNames[attrName] = field;
    const expressions: string[] = [];

    for (const [conditionType, value] of Object.entries(conditions)) {
      if (value === undefined) continue;

      const expression = this.buildCondition(
        conditionType as keyof QueryFilters,
        value,
        attrName,
        counter,
        attributeValues
      );

      if (expression !== null) {
        expressions.push(expression);
      }
    }

    return expressions;
  }

  private buildCondition(
    conditionType: keyof QueryFilters,
    value: unknown,
    attrName: string,
    counter: { value: number },
    attributeValues: Record<string, unknown>
  ): string | null {
    switch (conditionType) {
      case 'contains':
        return this.buildContains(value, attrName, counter, attributeValues);

      case 'equals': {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = value;
        counter.value++;
        return `${attrName} = ${valName}`;
      }

      case 'notEquals': {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = value;
        counter.value++;
        return `${attrName} <> ${valName}`;
      }

      case 'exists':
        if (value) {
          return `attribute_exists(${attrName})`;
        } else {
          return `attribute_not_exists(${attrName})`;
        }

      case 'beginsWith': {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = value;
        counter.value++;
        return `begins_with(${attrName}, ${valName})`;
      }

      case 'between': {
        const [val1, val2] = value as [unknown, unknown];
        const val1Name = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        counter.value++;
        const val2Name = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        counter.value++;
        attributeValues[val1Name] = val1;
        attributeValues[val2Name] = val2;
        return `${attrName} BETWEEN ${val1Name} AND ${val2Name}`;
      }

      case 'greaterThan': {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = value;
        counter.value++;
        return `${attrName} > ${valName}`;
      }

      case 'greaterThanOrEqual': {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = value;
        counter.value++;
        return `${attrName} >= ${valName}`;
      }

      case 'lessThan': {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = value;
        counter.value++;
        return `${attrName} < ${valName}`;
      }

      case 'lessThanOrEqual': {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = value;
        counter.value++;
        return `${attrName} <= ${valName}`;
      }

      case 'in': {
        const values = value as unknown[];
        if (!values.length) return null;
        const placeholders = values.map((v) => {
          const placeholder = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
          attributeValues[placeholder] = v;
          counter.value++;
          return placeholder;
        });
        return `${attrName} IN (${placeholders.join(', ')})`;
      }

      case 'notIn': {
        const values = value as unknown[];
        if (!values.length) return null;
        const placeholders = values.map((v) => {
          const placeholder = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
          attributeValues[placeholder] = v;
          counter.value++;
          return placeholder;
        });
        return `NOT (${attrName} IN (${placeholders.join(', ')}))`;
      }

      default:
        throw new ValidationError(
          `Unsupported filter operator: '${String(conditionType)}'. ` +
            `Supported: equals, notEquals, exists, beginsWith, between, greaterThan, greaterThanOrEqual, lessThan, lessThanOrEqual, contains, in, notIn.`,
          { operator: String(conditionType) },
        );
    }
  }

  private buildContains(
    value: unknown,
    attrName: string,
    counter: { value: number },
    attributeValues: Record<string, unknown>
  ): string {
    if (Array.isArray(value) && value.length > 0) {
      const containsExpressions = value.map((item) => {
        const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
        attributeValues[valName] = item;
        counter.value++;
        return `contains(${attrName}, ${valName})`;
      });
      return `(${containsExpressions.join(' OR ')})`;
    } else {
      const valName = `${EXPRESSION_PLACEHOLDERS.VALUE_PREFIX}${counter.value}`;
      attributeValues[valName] = value;
      counter.value++;
      return `contains(${attrName}, ${valName})`;
    }
  }

  private buildResult(
    filterExpressions: string[],
    attributeNames: Record<string, string>,
    attributeValues: Record<string, unknown>
  ): FilterResult {
    const result: FilterResult = {};

    if (filterExpressions.length) {
      result.FilterExpression = filterExpressions.join(' AND ');
    }
    if (Object.keys(attributeNames).length > 0) {
      result.ExpressionAttributeNames = attributeNames;
    }
    if (Object.keys(attributeValues).length > 0) {
      result.ExpressionAttributeValues = attributeValues;
    }

    return result;
  }
}
