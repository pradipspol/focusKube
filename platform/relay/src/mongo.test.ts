import test from 'node:test';
import assert from 'node:assert/strict';
import { disableMongoRetryWrites } from './mongo.js';

test('MongoDB connection URI disables retryable writes and preserves other options', () => {
  const uri = 'mongodb://user:pass@db-a:27017,db-b:27017/focuskube?retryWrites=true&authSource=admin';
  const result = disableMongoRetryWrites(uri);

  assert.equal(result, 'mongodb://user:pass@db-a:27017,db-b:27017/focuskube?retryWrites=false&authSource=admin');
});

test('MongoDB connection URI adds retryWrites=false when the option is absent', () => {
  assert.equal(
    disableMongoRetryWrites('mongodb+srv://user:pass@cluster.example/focuskube'),
    'mongodb+srv://user:pass@cluster.example/focuskube?retryWrites=false',
  );
});