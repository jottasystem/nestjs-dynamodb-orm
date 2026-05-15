import {
  DynamoDBOrmError,
  MetadataError,
  ConditionFailedError,
  ThroughputExceededError,
  EntityNotFoundError,
  InvalidEntityError,
  ValidationError,
} from '../dynamodb-orm.errors';

describe('Error Hierarchy', () => {
  const errorClasses = [
    { Class: DynamoDBOrmError, expectedName: 'DynamoDBOrmError' },
    { Class: MetadataError, expectedName: 'MetadataError' },
    { Class: ConditionFailedError, expectedName: 'ConditionFailedError' },
    { Class: ThroughputExceededError, expectedName: 'ThroughputExceededError' },
    { Class: EntityNotFoundError, expectedName: 'EntityNotFoundError' },
    { Class: InvalidEntityError, expectedName: 'InvalidEntityError' },
    { Class: ValidationError, expectedName: 'ValidationError' },
  ];

  describe.each(errorClasses)(
    '$expectedName',
    ({ Class, expectedName }) => {
      it('should be an instance of Error', () => {
        const error = new Class('test message');
        expect(error).toBeInstanceOf(Error);
      });

      it('should be an instance of DynamoDBOrmError', () => {
        const error = new Class('test message');
        expect(error).toBeInstanceOf(DynamoDBOrmError);
      });

      it(`should have name set to "${expectedName}"`, () => {
        const error = new Class('test message');
        expect(error.name).toBe(expectedName);
      });

      it('should preserve the message', () => {
        const error = new Class('something went wrong');
        expect(error.message).toBe('something went wrong');
      });

      it('should preserve context when provided', () => {
        const context = { entity: 'User', operation: 'create', key: { pk: '123' } };
        const error = new Class('failed', context);
        expect(error.context).toEqual(context);
      });

      it('should have undefined context when not provided', () => {
        const error = new Class('no context');
        expect(error.context).toBeUndefined();
      });
    },
  );
});
