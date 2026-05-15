import 'reflect-metadata';
import {
  DynamoDBOrmModule,
  DYNAMODB_ORM_CLIENT_OPTIONS,
  DYNAMODB_ORM_LOGGER,
  DYNAMODB_ORM_REPOSITORY_OPTIONS,
} from '../dynamodb-orm.module';
import {
  Table,
  PartitionKey,
  SortKey,
  Attribute,
  generateRepositoryToken,
} from '../dynamodb-orm-decorators/entity.decorators';
import { DynamoDBOrmInitializer } from '../dynamodb-orm.initializer';

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/module-test')
class ModuleEntity {
  @PartitionKey()
  pk!: string;

  @SortKey()
  sk!: string;

  @Attribute()
  name!: string;
}

@Table('arn:aws:dynamodb:us-east-1:000000000000:table/module-test-2')
class SecondModuleEntity {
  @PartitionKey()
  id!: string;

  @Attribute()
  value!: string;
}

describe('DynamoDBOrmModule.forRoot', () => {
  it('produces a global module with logger, client and repository options providers', () => {
    const dynamic = DynamoDBOrmModule.forRoot({});
    expect(dynamic.module).toBe(DynamoDBOrmModule);
    expect(dynamic.global).toBe(true);

    const tokens = dynamic.providers!.map((p: any) => p.provide);
    expect(tokens).toContain(DYNAMODB_ORM_LOGGER);
    expect(tokens).toContain(DYNAMODB_ORM_CLIENT_OPTIONS);
    expect(tokens).toContain(DYNAMODB_ORM_REPOSITORY_OPTIONS);

    const exportTokens = (dynamic.exports as any[]).map((p) => p.provide);
    expect(exportTokens).toContain(DYNAMODB_ORM_LOGGER);
  });

  it('uses provided logger when supplied', () => {
    const customLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const dynamic = DynamoDBOrmModule.forRoot({ logger: customLogger });
    const loggerProvider = (dynamic.providers as any[]).find(
      (p) => p.provide === DYNAMODB_ORM_LOGGER,
    );
    expect(loggerProvider.useValue).toBe(customLogger);
  });

  it('defaults clientOptions to {} when omitted', () => {
    const dynamic = DynamoDBOrmModule.forRoot({});
    const clientProvider = (dynamic.providers as any[]).find(
      (p) => p.provide === DYNAMODB_ORM_CLIENT_OPTIONS,
    );
    expect(clientProvider.useValue).toEqual({});
  });
});

describe('DynamoDBOrmModule.forFeature', () => {
  it('produces a dynamic module with one repository provider per entity', () => {
    const dynamic = DynamoDBOrmModule.forFeature([ModuleEntity, SecondModuleEntity]);
    expect(dynamic.module).toBe(DynamoDBOrmModule);

    const tokens = (dynamic.providers as any[]).map((p) => p.provide);
    expect(tokens).toContain(generateRepositoryToken(ModuleEntity));
    expect(tokens).toContain(generateRepositoryToken(SecondModuleEntity));
  });

  it('exports the initializer plus all repository providers', () => {
    const dynamic = DynamoDBOrmModule.forFeature([ModuleEntity]);
    const exportTokens = (dynamic.exports as any[]).map((p: any) =>
      typeof p === 'function' ? p : p.provide,
    );
    expect(exportTokens).toContain(DynamoDBOrmInitializer);
    expect(exportTokens).toContain(generateRepositoryToken(ModuleEntity));
  });

  it('repository providers inject logger/client-options/repository-options as OPTIONAL — never shadow forRoot', () => {
    const dynamic = DynamoDBOrmModule.forFeature([ModuleEntity]);
    const repoProvider = (dynamic.providers as any[]).find(
      (p) => p.provide === generateRepositoryToken(ModuleEntity),
    );
    expect(repoProvider.inject).toEqual([
      { token: DYNAMODB_ORM_LOGGER, optional: true },
      { token: DYNAMODB_ORM_CLIENT_OPTIONS, optional: true },
      { token: DYNAMODB_ORM_REPOSITORY_OPTIONS, optional: true },
    ]);
  });

  it('forFeature does NOT register fallback providers — relies on forRoot or optional inject', () => {
    // Regression: previously forFeature emitted useValue providers for each
    // injection token which silently shadowed the global forRoot config.
    const dynamic = DynamoDBOrmModule.forFeature([ModuleEntity]);
    const tokens = (dynamic.providers as any[]).map((p) => p.provide);
    expect(tokens).not.toContain(DYNAMODB_ORM_LOGGER);
    expect(tokens).not.toContain(DYNAMODB_ORM_CLIENT_OPTIONS);
    expect(tokens).not.toContain(DYNAMODB_ORM_REPOSITORY_OPTIONS);
  });
});
