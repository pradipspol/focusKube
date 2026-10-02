import { mongoCollections } from '../mongoCollections.js';
import { OrganizationService } from './store.js';

export const organizationService = new OrganizationService({
  organizations: mongoCollections.organizations,
  members: mongoCollections.organization_members,
  invites: mongoCollections.organization_invites,
  licenses: mongoCollections.licenses,
  users: mongoCollections.users,
});