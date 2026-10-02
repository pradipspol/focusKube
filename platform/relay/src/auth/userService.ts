import { mongoCollections } from '../mongoCollections.js';
import { UserService } from './users.js';

export const userService = new UserService(mongoCollections.users);