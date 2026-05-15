/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  AfterLoad,
  BeforeInsert,
  BeforeUpdate,
} from './entity.decorators';
import { ensureEntityMetadata } from '../dynamodb-orm.metadata-store';

type FieldSelector<T> = (resource: T) => Record<string, unknown>;

function normalizeSearchString(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Builds a positional search-key string. Each field becomes a segment,
 * joined by `|`; arrays inside a segment are joined by `;`. Missing
 * (undefined/null) values become EMPTY segments — never dropped — so the
 * position of each field remains stable across entities. This lets you
 * `beginsWith` against the prefix safely.
 *
 * Example:
 *   { name: 'João', tags: ['x'], city: undefined } → "joao|x|"
 */
function computeSearchKeyFromFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const key of Object.keys(fields)) {
    const value = fields[key];

    if (value === undefined || value === null) {
      parts.push('');
      continue;
    }

    if (Array.isArray(value)) {
      const joined = value
        .filter((v) => v !== undefined && v !== null)
        .map((v) => normalizeSearchString(String(v)))
        .join(';');
      parts.push(joined);
      continue;
    }

    parts.push(normalizeSearchString(String(value)));
  }

  return parts.join('|');
}

/**
 * `@GenerateSearchKey` — registers `BeforeInsert`/`BeforeUpdate` hooks that
 * compute the decorated property from the entity's other fields, and an
 * `AfterLoad` hook that *removes* the property from loaded instances.
 *
 * IMPORTANT: After `findOne()`/`find()`, the decorated property will be
 * `undefined` on the resulting entity instance even though it exists in
 * DynamoDB. This is intentional — the search key is treated as an
 * implementation detail of the index, not domain state.
 */
function GenerateSearchKey<T = unknown>(fieldSelector: FieldSelector<T>) {
  return function (target: object, propertyKey: string) {
    const metadata = ensureEntityMetadata(target.constructor as object & { name: string });

    if (!metadata.attributes[propertyKey]) {
      metadata.attributes[propertyKey] = {};
    }

    const COMPUTE_KEY = `computeSearchKeyFor${propertyKey}`;
    const CLEAR_KEY = `clearSearchKeyFor${propertyKey}`;

    const computeSearchKey = function (this: T) {
      const fields = fieldSelector(this);

      // If EVERY selected source field is missing/empty, the user's partial
      // update did not touch any of the inputs that compose this search key.
      // Writing a degenerate value (e.g. "||") would overwrite the real
      // search key already stored in DynamoDB and break index lookups.
      // Instead, delete the property so `update()` doesn't emit a SET for it.
      const allMissing = Object.values(fields).every(
        (v) =>
          v === undefined ||
          v === null ||
          (Array.isArray(v) && v.length === 0),
      );
      if (allMissing) {
        delete (this as Record<string, unknown>)[propertyKey];
        return;
      }

      (this as Record<string, unknown>)[propertyKey] = computeSearchKeyFromFields(fields);
    };

    const clearSearchKey = function (this: T) {
      delete (this as Record<string, unknown>)[propertyKey];
    };

    Object.defineProperty(target, COMPUTE_KEY, {
      value: computeSearchKey,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(target, CLEAR_KEY, {
      value: clearSearchKey,
      writable: true,
      configurable: true,
    });

    const computeDescriptor = Object.getOwnPropertyDescriptor(
      target,
      COMPUTE_KEY
    )!;
    const clearDescriptor = Object.getOwnPropertyDescriptor(target, CLEAR_KEY)!;

    BeforeInsert()(target, COMPUTE_KEY, computeDescriptor);
    BeforeUpdate()(target, COMPUTE_KEY, computeDescriptor);

    AfterLoad()(target, CLEAR_KEY, clearDescriptor);
  };
}

export { GenerateSearchKey, normalizeSearchString, computeSearchKeyFromFields };
