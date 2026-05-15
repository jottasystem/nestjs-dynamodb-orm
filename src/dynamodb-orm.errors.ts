export class DynamoDBOrmError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DynamoDBOrmError';
  }
}

export class MetadataError extends DynamoDBOrmError {
  override name = 'MetadataError';
}

export class ConditionFailedError extends DynamoDBOrmError {
  override name = 'ConditionFailedError';
}

export class ThroughputExceededError extends DynamoDBOrmError {
  override name = 'ThroughputExceededError';
}

export class EntityNotFoundError extends DynamoDBOrmError {
  override name = 'EntityNotFoundError';
}

export class InvalidEntityError extends DynamoDBOrmError {
  override name = 'InvalidEntityError';
}

export class ValidationError extends DynamoDBOrmError {
  override name = 'ValidationError';
}
