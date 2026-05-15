import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TableManager } from './dynamodb-orm.table-manager';
import { getEntityMetadata } from './dynamodb-orm.metadata-store';
import { MetadataError } from './dynamodb-orm.errors';
import { LoggerInterface } from './dynamodb-orm.types';
import { EntityTarget } from './dynamodb-orm-decorators/entity.decorators';

@Injectable()
export class DynamoDBOrmInitializer implements OnApplicationBootstrap {
  constructor(
    private readonly entities: EntityTarget[] = [],
    private readonly tableManager: TableManager = new TableManager(),
    private readonly logger: LoggerInterface = new Logger('DynamoDBOrmInitializer'),
  ) {}

  async onApplicationBootstrap() {
    for (const entity of this.entities) {
      this.logger.debug(`Validating table ARN for entity ${entity.name}`);

      try {
        const metadata = getEntityMetadata(entity);
        if (metadata?.tableArn) {
          await this.tableManager.validateTableArn(metadata.tableArn, metadata.keys);
        }
      } catch (error) {
        if (error instanceof MetadataError) {
          this.logger.warn(
            `No metadata found for entity ${entity.name}. Skipping ARN validation.`,
            { entity: entity.name },
          );
          continue;
        }
        throw error;
      }
    }

    this.logger.debug('[DynamoDBOrm] All table ARNs validated successfully.');
  }
}
