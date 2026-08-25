import type { AuthUser, UserSessionState } from '../auth/session.js';

declare global {
  namespace Express {
    interface Request {
      authUser: AuthUser | null;
      userSession: UserSessionState;
      logOperation?: string;
      logRequestId?: string;
    }
  }
}

export {};
