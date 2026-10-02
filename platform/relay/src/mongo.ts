import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { config } from './config.js';
import { logInfo } from './logger.js';
import { mongoCollections } from './mongoCollections.js';

let client: MongoClient | undefined;
let database: Db | undefined;

export function disableMongoRetryWrites(uri: string): string {
  const queryIndex = uri.indexOf('?');
  const baseUri = queryIndex < 0 ? uri : uri.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : uri.slice(queryIndex + 1));
  query.set('retryWrites', 'false');
  return `${baseUri}?${query.toString()}`;
}

export async function connectDb(): Promise<void> {
  if (!config.mongodbUri) throw new Error('MONGODB_URI is required to connect the relay to MongoDB Atlas');

  client = new MongoClient(disableMongoRetryWrites(config.mongodbUri), { retryWrites: false });
  await client.connect();
  database = client.db(config.mongodbDbName);

  await Promise.all(Object.values(mongoCollections).map((service) => service.initialize(database!)));
  logInfo('Relay MongoDB connection established', { database: config.mongodbDbName });
}

export async function withTransaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
  if (!client) throw new Error('MongoDB has not been connected');
  const session = client.startSession();
  let result!: T;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
  database = undefined;
}