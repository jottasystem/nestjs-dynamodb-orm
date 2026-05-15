import {
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
} from '../dynamodb-orm-decorators/entity.decorators';
import {
  getEntityMetadata,
  getHooksMetadata,
} from '../dynamodb-orm.metadata-store';


describe('Decorators', () => {
  // Each test uses fresh classes to avoid WeakMap interference

  describe('@Table', () => {
    it('should parse a valid ARN and set tableName, tableArn, and region', () => {
      @Table('arn:aws:dynamodb:us-east-1:123456789012:table/MyTable')
      class ValidArnEntity {}

      const metadata = getEntityMetadata(ValidArnEntity);
      expect(metadata.tableArn).toBe(
        'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable',
      );
      expect(metadata.tableName).toBe('MyTable');
      expect(metadata.region).toBe('us-east-1');
    });

    it('should throw for an empty ARN', () => {
      expect(() => {
        @Table('')
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        class _EmptyArnEntity {}
      }).toThrow(/ARN is required/);
    });

    it('should throw for an ARN that does not start with arn:aws:dynamodb:', () => {
      expect(() => {
        @Table('arn:aws:s3:::my-bucket')
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        class _InvalidPrefixEntity {}
      }).toThrow(/Invalid DynamoDB table ARN format/);
    });

    it('should throw for an ARN missing the table name segment', () => {
      expect(() => {
        @Table('arn:aws:dynamodb:us-east-1:123456789012:no-table-here')
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        class _MissingTableEntity {}
      }).toThrow(/Invalid table name in ARN/);
    });
  });

  describe('@PartitionKey', () => {
    it('should register the partition key in entity metadata', () => {
      @Table('arn:aws:dynamodb:eu-west-1:111111111111:table/PkTest')
      class PkEntity {
        @PartitionKey()
        myPk!: string;
      }

      const metadata = getEntityMetadata(PkEntity);
      expect(metadata.keys.partitionKey).toBe('myPk');
    });
  });

  describe('@SortKey', () => {
    it('should register the sort key in entity metadata', () => {
      @Table('arn:aws:dynamodb:eu-west-1:111111111111:table/SkTest')
      class SkEntity {
        @PartitionKey()
        pk!: string;

        @SortKey()
        mySk!: string;
      }

      const metadata = getEntityMetadata(SkEntity);
      expect(metadata.keys.sortKey).toBe('mySk');
    });
  });

  describe('@Index', () => {
    it('should register a GSI with partitionKey', () => {
      @Table('arn:aws:dynamodb:us-west-2:222222222222:table/IndexTest')
      class GsiEntity {
        @PartitionKey()
        pk!: string;

        @Index({ type: 'GSI', partitionKey: 'email', name: 'GSI_email' })
        @Attribute()
        email!: string;
      }

      const metadata = getEntityMetadata(GsiEntity);
      expect(metadata.indexes).toHaveLength(1);
      expect(metadata.indexes[0]).toMatchObject({
        type: 'GSI',
        partitionKey: 'email',
        name: 'GSI_email',
        attribute: 'email',
      });
    });

    it('should register an LSI with auto-generated name', () => {
      @Table('arn:aws:dynamodb:us-west-2:222222222222:table/LsiTest')
      class LsiEntity {
        @PartitionKey()
        pk!: string;

        @SortKey()
        sk!: string;

        @Index({ type: 'LSI' })
        @Attribute()
        createdAt!: string;
      }

      const metadata = getEntityMetadata(LsiEntity);
      expect(metadata.indexes).toHaveLength(1);
      expect(metadata.indexes[0]).toMatchObject({
        type: 'LSI',
        name: 'LSI_createdAt',
        attribute: 'createdAt',
        sortKey: 'createdAt',
      });
    });

    it('should throw when GSI is missing partitionKey', () => {
      expect(() => {
        @Table('arn:aws:dynamodb:us-west-2:222222222222:table/GsiNoPartition')
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        class _GsiNoPartitionEntity {
          @PartitionKey()
          pk!: string;

          @Index({ type: 'GSI' })
          @Attribute()
          email!: string;
        }
      }).toThrow(/GSI .* requires a partitionKey/);
    });

    it('should register the attribute in metadata.attributes if not already present', () => {
      @Table('arn:aws:dynamodb:us-west-2:222222222222:table/IndexAttrTest')
      class IndexAttrEntity {
        @PartitionKey()
        pk!: string;

        @Index({ type: 'GSI', partitionKey: 'status' })
        status!: string;
      }

      const metadata = getEntityMetadata(IndexAttrEntity);
      expect(metadata.attributes).toHaveProperty('status');
    });
  });

  describe('Hook registration', () => {
    it('should register @BeforeInsert hooks', () => {
      class BeforeInsertEntity {
        @BeforeInsert()
        onBeforeInsert() {
          /* noop */
        }
      }

      const hooks = getHooksMetadata(BeforeInsertEntity);
      expect(hooks.beforeInsert).toContain('onBeforeInsert');
    });

    it('should register @BeforeUpdate hooks', () => {
      class BeforeUpdateEntity {
        @BeforeUpdate()
        onBeforeUpdate() {
          /* noop */
        }
      }

      const hooks = getHooksMetadata(BeforeUpdateEntity);
      expect(hooks.beforeUpdate).toContain('onBeforeUpdate');
    });

    it('should register @AfterInsert hooks', () => {
      class AfterInsertEntity {
        @AfterInsert()
        onAfterInsert() {
          /* noop */
        }
      }

      const hooks = getHooksMetadata(AfterInsertEntity);
      expect(hooks.afterInsert).toContain('onAfterInsert');
    });

    it('should register @AfterUpdate hooks', () => {
      class AfterUpdateEntity {
        @AfterUpdate()
        onAfterUpdate() {
          /* noop */
        }
      }

      const hooks = getHooksMetadata(AfterUpdateEntity);
      expect(hooks.afterUpdate).toContain('onAfterUpdate');
    });

    it('should register @AfterLoad hooks', () => {
      class AfterLoadEntity {
        @AfterLoad()
        onAfterLoad() {
          /* noop */
        }
      }

      const hooks = getHooksMetadata(AfterLoadEntity);
      expect(hooks.afterLoad).toContain('onAfterLoad');
    });

    it('should register multiple hooks on the same entity', () => {
      class MultiHookEntity {
        @BeforeInsert()
        hookA() {
          /* noop */
        }

        @BeforeInsert()
        hookB() {
          /* noop */
        }

        @AfterLoad()
        hookC() {
          /* noop */
        }
      }

      const hooks = getHooksMetadata(MultiHookEntity);
      expect(hooks.beforeInsert).toEqual(
        expect.arrayContaining(['hookA', 'hookB']),
      );
      expect(hooks.afterLoad).toContain('hookC');
    });
  });

  describe('@Attribute({ nullable: false }) — metadata registration (REQ-002)', () => {
    it('should store nullable: false in attribute metadata', () => {
      @Table('arn:aws:dynamodb:us-east-1:123456789012:table/NullableTest')
      class MultiNullableEntity {
        @PartitionKey()
        pk!: string;

        @Attribute({ nullable: false })
        fieldA!: string;

        @Attribute({ nullable: false })
        fieldB!: string;

        @Attribute()
        fieldC!: number;
      }

      const metadata = getEntityMetadata(MultiNullableEntity);
      expect(metadata.attributes['fieldA'].nullable).toBe(false);
      expect(metadata.attributes['fieldB'].nullable).toBe(false);
      expect(metadata.attributes['fieldC'].nullable).toBeUndefined();
    });

    it('should not register validation hooks on the prototype (validation moved to EntityHelpers)', () => {
      @Table('arn:aws:dynamodb:us-east-1:123456789012:table/ProtoTest')
      class ProtoNullableEntity {
        @PartitionKey()
        pk!: string;

        @Attribute({ nullable: false })
        name!: string;
      }

      const hooks = getHooksMetadata(ProtoNullableEntity);
      const validationHooks = hooks.beforeInsert.filter((h) => h.startsWith('validateNonNullable_'));
      expect(validationHooks).toHaveLength(0);
    });
  });

  describe('@Attribute basic options', () => {
    it('should register attribute metadata with hidden and default options', () => {
      @Table('arn:aws:dynamodb:us-east-1:123456789012:table/AttrOpts')
      class AttrOptsEntity {
        @PartitionKey()
        pk!: string;

        @Attribute({ hidden: true })
        secret!: string;

        @Attribute({ default: 'hello' })
        greeting!: string;

        @Attribute()
        plain!: string;
      }

      const metadata = getEntityMetadata(AttrOptsEntity);
      expect(metadata.attributes['secret']).toEqual({ hidden: true });
      expect(metadata.attributes['greeting']).toEqual({ default: 'hello' });
      expect(metadata.attributes['plain']).toEqual({});
    });
  });
});
