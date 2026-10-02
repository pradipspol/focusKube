import type {
  AggregateOptions,
  AggregationCursor,
  AnyBulkWriteOperation,
  BulkWriteOptions,
  BulkWriteResult,
  Collection,
  CountDocumentsOptions,
  CreateIndexesOptions,
  Db,
  DeleteOptions,
  DeleteResult,
  Document,
  EstimatedDocumentCountOptions,
  Filter,
  FindCursor,
  FindOptions,
  IndexSpecification,
  InsertManyResult,
  InsertOneOptions,
  OptionalUnlessRequiredId,
  ReplaceOptions,
  FindOneAndUpdateOptions,
  FindOneAndDeleteOptions,
  UpdateFilter,
  UpdateOptions,
  UpdateResult,
  WithId,
} from 'mongodb';
import { logError, logInfo } from './logger.js';

export interface MongoIndexDefinition {
  keys: IndexSpecification;
  options?: CreateIndexesOptions;
}

export abstract class MongoDBService<T extends Document> {
  private collection?: Collection<T>;

  protected abstract readonly collectionName: string;
  protected readonly indexes: MongoIndexDefinition[] = [];

  async initialize(database: Db): Promise<string[]> {
    this.collection = database.collection<T>(this.collectionName);
    try {
      const indexes = await this.execute('createIndexes', () => Promise.all(
        this.indexes.map(({ keys, options }) => this.collection!.createIndex(keys, options)),
      ));
      logInfo('MongoDB collection initialized', { collection: this.collectionName, indexCount: indexes.length });
      return indexes;
    } catch (error) {
      this.collection = undefined;
      throw error;
    }
  }

  protected getCollection(): Collection<T> {
    if (!this.collection) throw new Error(`MongoDB collection '${this.collectionName}' has not been initialized`);
    return this.collection;
  }

  private async execute<TResult>(operation: string, action: () => Promise<TResult>): Promise<TResult> {
    try {
      return await action();
    } catch (error) {
      logError('MongoDB operation failed', error, { collection: this.collectionName, operation });
      throw error;
    }
  }

  private logCursorFailure(operation: string, error: unknown): never {
    logError('MongoDB cursor operation failed', error, { collection: this.collectionName, operation });
    throw error;
  }

  private observeCursor<C extends FindCursor<WithId<T>> | AggregationCursor<Document>>(
    operation: string,
    cursor: C,
  ): C {
    let proxy: C;
    proxy = new Proxy(cursor, {
      get: (target, property) => {
        const method: unknown = Reflect.get(target, property, target);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          try {
            const result: unknown = method.apply(target, args);
            if (property === Symbol.asyncIterator && result && typeof result === 'object') {
              return new Proxy(result, {
                get: (iterator, iteratorProperty) => {
                  const iteratorMethod: unknown = Reflect.get(iterator, iteratorProperty, iterator);
                  if (typeof iteratorMethod !== 'function') return iteratorMethod;
                  return (...iteratorArgs: unknown[]) => {
                    try {
                      return Promise.resolve(iteratorMethod.apply(iterator, iteratorArgs))
                        .catch((error: unknown) => this.logCursorFailure(operation, error));
                    } catch (error) {
                      return this.logCursorFailure(operation, error);
                    }
                  };
                },
              });
            }
            if (result === target) return proxy;
            if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
              return Promise.resolve(result).catch((error: unknown) => this.logCursorFailure(operation, error));
            }
            return result;
          } catch (error) {
            return this.logCursorFailure(operation, error);
          }
        };
      },
    });
    return proxy;
  }

  insertOne(document: OptionalUnlessRequiredId<T>, options?: InsertOneOptions) {
    return this.execute('insertOne', () => this.getCollection().insertOne(document, options));
  }

  insertMany(documents: OptionalUnlessRequiredId<T>[], options?: BulkWriteOptions): Promise<InsertManyResult<T>> {
    return this.execute('insertMany', () => this.getCollection().insertMany(documents, options));
  }

  findOne(filter: Filter<T>, options?: FindOptions): Promise<T | null> {
    return this.execute('findOne', () => this.getCollection().findOne(filter, options) as Promise<T | null>);
  }

  find(filter: Filter<T> = {}, options?: FindOptions): FindCursor<WithId<T>> {
    try {
      return this.observeCursor('find', this.getCollection().find(filter, options));
    } catch (error) {
      return this.logCursorFailure('find', error);
    }
  }

  aggregate<R extends Document = Document>(pipeline: Document[] = [], options?: AggregateOptions): AggregationCursor<R> {
    try {
      return this.observeCursor('aggregate', this.getCollection().aggregate<R>(pipeline, options)) as AggregationCursor<R>;
    } catch (error) {
      return this.logCursorFailure('aggregate', error);
    }
  }

  countDocuments(filter: Filter<T> = {}, options?: CountDocumentsOptions): Promise<number> {
    return this.execute('countDocuments', () => this.getCollection().countDocuments(filter, options));
  }

  estimatedDocumentCount(options?: EstimatedDocumentCountOptions): Promise<number> {
    return this.execute('estimatedDocumentCount', () => this.getCollection().estimatedDocumentCount(options));
  }

  updateOne(filter: Filter<T>, update: UpdateFilter<T> | Document[], options?: UpdateOptions): Promise<UpdateResult<T>> {
    return this.execute('updateOne', () => this.getCollection().updateOne(filter, update, options));
  }

  updateMany(filter: Filter<T>, update: UpdateFilter<T> | Document[], options?: UpdateOptions): Promise<UpdateResult<T>> {
    return this.execute('updateMany', () => this.getCollection().updateMany(filter, update, options));
  }

  replaceOne(filter: Filter<T>, replacement: OptionalUnlessRequiredId<T>, options?: ReplaceOptions): Promise<UpdateResult<T>> {
    return this.execute('replaceOne', () => this.getCollection().replaceOne(filter, replacement, options));
  }

  findOneAndUpdate(filter: Filter<T>, update: UpdateFilter<T> | Document[], options?: FindOneAndUpdateOptions): Promise<T | null> {
    const collection = this.getCollection();
    return this.execute('findOneAndUpdate', () => (options
      ? collection.findOneAndUpdate(filter, update, options)
      : collection.findOneAndUpdate(filter, update)) as Promise<T | null>);
  }

  findOneAndDelete(filter: Filter<T>, options?: FindOneAndDeleteOptions): Promise<T | null> {
    const collection = this.getCollection();
    return this.execute('findOneAndDelete', () => (options
      ? collection.findOneAndDelete(filter, options)
      : collection.findOneAndDelete(filter)) as Promise<T | null>);
  }

  deleteOne(filter: Filter<T>, options?: DeleteOptions): Promise<DeleteResult> {
    return this.execute('deleteOne', () => this.getCollection().deleteOne(filter, options));
  }

  deleteMany(filter: Filter<T>, options?: DeleteOptions): Promise<DeleteResult> {
    return this.execute('deleteMany', () => this.getCollection().deleteMany(filter, options));
  }

  bulkWrite(operations: AnyBulkWriteOperation<T>[], options?: BulkWriteOptions): Promise<BulkWriteResult> {
    return this.execute('bulkWrite', () => this.getCollection().bulkWrite(operations, options));
  }
}