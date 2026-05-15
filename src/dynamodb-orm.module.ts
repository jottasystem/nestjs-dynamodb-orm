import { DynamicModule, Logger, Module, Provider } from '@nestjs/common';
import {
  EntityTarget,
  generateRepositoryToken,
} from './dynamodb-orm-decorators/entity.decorators';
import {
  createDocumentClient,
  DocumentClientFactoryOptions,
} from './dynamodb-orm.document-client';
import { DynamoDBOrmInitializer } from './dynamodb-orm.initializer';
import { getEntityMetadata } from './dynamodb-orm.metadata-store';
import { DynamoDBOrmRepository } from './dynamodb-orm.repository';
import { TableManager } from './dynamodb-orm.table-manager';
import { LoggerInterface, RepositoryOptions } from './dynamodb-orm.types';

export const DYNAMODB_ORM_LOGGER = Symbol('DYNAMODB_ORM_LOGGER');
export const DYNAMODB_ORM_CLIENT_OPTIONS = Symbol('DYNAMODB_ORM_CLIENT_OPTIONS');
export const DYNAMODB_ORM_REPOSITORY_OPTIONS = Symbol('DYNAMODB_ORM_REPOSITORY_OPTIONS');

export interface DynamoDBOrmRootOptions {
  /** Custom logger. Defaults to `@nestjs/common` `Logger`. Pass a `noop` object to silence. */
  logger?: LoggerInterface;
  /** Client factory options applied to every repository (endpoint, credentials, marshall overrides, …). */
  clientOptions?: DocumentClientFactoryOptions;
  /** Defaults applied to every repository (`verbose`, `maxRetries`, `pageSize`). */
  repositoryOptions?: RepositoryOptions;
}

function defaultLogger(): LoggerInterface {
  return new Logger('DynamoDBOrm');
}

@Module({})
export class DynamoDBOrmModule {
  /**
   * Register global configuration for the ORM. Optional — calling only
   * `forFeature()` is enough for default behaviour with the standard AWS
   * credentials chain.
   *
   * Marked `global: true` so a single call from the root module reaches
   * every `forFeature` invocation across the dependency graph.
   *
   * @example
   * DynamoDBOrmModule.forRoot({
   *   clientOptions: { clientConfig: { endpoint: 'http://localhost:8000' } },
   *   repositoryOptions: { verbose: true, maxRetries: 5 },
   * })
   */
  static forRoot(options: DynamoDBOrmRootOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: DYNAMODB_ORM_LOGGER,
        useValue: options.logger ?? defaultLogger(),
      },
      {
        provide: DYNAMODB_ORM_CLIENT_OPTIONS,
        useValue: options.clientOptions ?? {},
      },
      {
        provide: DYNAMODB_ORM_REPOSITORY_OPTIONS,
        useValue: options.repositoryOptions ?? {},
      },
    ];

    return {
      module: DynamoDBOrmModule,
      global: true,
      providers,
      exports: providers,
    };
  }

  /**
   * Register one or more entities, providing a `DynamoDBOrmRepository`
   * for each one. Uses optional injection so that `forRoot()` config is
   * picked up when present, and sensible defaults are used otherwise.
   *
   * **Important:** if you need custom `clientOptions` (LocalStack endpoint,
   * credentials, etc.) call `forRoot()` BEFORE `forFeature()`. The two
   * compose; `forFeature` never shadows `forRoot`.
   */
  static forFeature(entities: EntityTarget[]): DynamicModule {
    const tableManager = new TableManager();

    const repositoryProviders: Provider[] = entities.map((entity) => ({
      provide: generateRepositoryToken(entity),
      useFactory: (
        logger?: LoggerInterface,
        clientOptions?: DocumentClientFactoryOptions,
        repoOptions?: RepositoryOptions,
      ) => {
        const metadata = getEntityMetadata(entity);
        const documentClient = createDocumentClient(metadata, clientOptions ?? {});
        return new DynamoDBOrmRepository(
          entity,
          documentClient,
          repoOptions ?? {},
          logger ?? defaultLogger(),
        );
      },
      inject: [
        { token: DYNAMODB_ORM_LOGGER, optional: true },
        { token: DYNAMODB_ORM_CLIENT_OPTIONS, optional: true },
        { token: DYNAMODB_ORM_REPOSITORY_OPTIONS, optional: true },
      ],
    }));

    return {
      module: DynamoDBOrmModule,
      providers: [
        {
          provide: DynamoDBOrmInitializer,
          useFactory: (logger?: LoggerInterface) =>
            new DynamoDBOrmInitializer(entities, tableManager, logger ?? defaultLogger()),
          inject: [
            { token: DYNAMODB_ORM_LOGGER, optional: true },
          ],
        },
        ...repositoryProviders,
      ],
      exports: [DynamoDBOrmInitializer, ...repositoryProviders],
    };
  }
}
