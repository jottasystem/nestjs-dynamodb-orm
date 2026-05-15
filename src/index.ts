// Module
export {
  DynamoDBOrmModule,
  DYNAMODB_ORM_LOGGER,
  DYNAMODB_ORM_CLIENT_OPTIONS,
  DYNAMODB_ORM_REPOSITORY_OPTIONS,
} from './dynamodb-orm.module';
export type { DynamoDBOrmRootOptions } from './dynamodb-orm.module';

// Repository
export { DynamoDBOrmRepository } from './dynamodb-orm.repository';

// Document client
export type { DocumentClientFactoryOptions } from './dynamodb-orm.document-client';
export { createDocumentClient } from './dynamodb-orm.document-client';

// Table manager
export { TableManager } from './dynamodb-orm.table-manager';
export type { TableKeys } from './dynamodb-orm.table-manager';

// Decorators
export {
  Table,
  PartitionKey,
  SortKey,
  Attribute,
  Index,
  BeforeInsert,
  BeforeUpdate,
  AfterInsert,
  AfterUpdate,
  AfterLoad,
  InjectRepository,
  generateRepositoryToken,
} from './dynamodb-orm-decorators/entity.decorators';
export type { EntityTarget } from './dynamodb-orm-decorators/entity.decorators';
export {
  GenerateSearchKey,
  normalizeSearchString,
  computeSearchKeyFromFields,
} from './dynamodb-orm-decorators/search-key.decorator';

// Types
export type {
  BinaryType,
  DynamoKeyType,
  QueryOptions,
  QueryFilters,
  EntityFilters,
  FiltersInput,
  SortKeyCondition,
  CreateOptions,
  UpdateOptions,
  ScanOptions,
  CountOptions,
  RepositoryOptions,
  BatchWriteInput,
  BatchGetResult,
  LoggerInterface,
} from './dynamodb-orm.types';

// Errors
export {
  DynamoDBOrmError,
  MetadataError,
  ConditionFailedError,
  ThroughputExceededError,
  EntityNotFoundError,
  InvalidEntityError,
  ValidationError,
} from './dynamodb-orm.errors';
