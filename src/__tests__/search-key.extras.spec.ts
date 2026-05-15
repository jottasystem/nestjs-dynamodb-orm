import 'reflect-metadata';
import {
  computeSearchKeyFromFields,
  normalizeSearchString,
} from '../dynamodb-orm-decorators/search-key.decorator';

/**
 * B7 — `@GenerateSearchKey` must be positionally stable across missing fields.
 * "joao||x" vs "joao|x" matters for `beginsWith` queries on the index.
 */
describe('B7: computeSearchKeyFromFields produces positional segments', () => {
  it('keeps empty segment for undefined fields', () => {
    expect(
      computeSearchKeyFromFields({
        name: 'João',
        tags: undefined,
        city: 'sp',
      }),
    ).toBe('joao||sp');
  });

  it('keeps empty segment for null fields', () => {
    expect(
      computeSearchKeyFromFields({
        name: 'alpha',
        secondary: null,
      }),
    ).toBe('alpha|');
  });

  it('joins array values with `;` and stays positional', () => {
    expect(
      computeSearchKeyFromFields({
        name: 'alpha',
        tags: ['x', 'y'],
        city: 'sp',
      }),
    ).toBe('alpha|x;y|sp');
  });

  it('normalises accents in array values too', () => {
    expect(
      computeSearchKeyFromFields({
        name: 'João',
        labels: ['São Paulo', 'Brasília'],
      }),
    ).toBe('joao|sao paulo;brasilia');
  });

  it('handles empty arrays as empty segment, not missing', () => {
    expect(
      computeSearchKeyFromFields({
        name: 'a',
        tags: [],
        last: 'z',
      }),
    ).toBe('a||z');
  });

  it('preserves stable position regardless of input mix', () => {
    const a = computeSearchKeyFromFields({ a: 'x', b: 'y' });
    const b = computeSearchKeyFromFields({ a: 'x', b: undefined });
    const c = computeSearchKeyFromFields({ a: undefined, b: 'y' });

    expect(a.split('|')).toHaveLength(2);
    expect(b.split('|')).toHaveLength(2);
    expect(c.split('|')).toHaveLength(2);
  });
});

describe('normalizeSearchString', () => {
  it('removes diacritics', () => {
    expect(normalizeSearchString('São João')).toBe('sao joao');
  });

  it('lowercases and trims', () => {
    expect(normalizeSearchString('  Hello  ')).toBe('hello');
  });
});
