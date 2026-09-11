import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

let client: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!client) {
    client = new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
  }
  return client;
}

export function isGoogleConfigured(): boolean {
  return !!(config.google.clientId && config.google.clientSecret);
}

export function googleAuthUrl(state: string): string {
  return getClient().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
  });
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

export async function verifyGoogleCode(code: string): Promise<GoogleProfile> {
  const oauthClient = getClient();
  const { tokens } = await oauthClient.getToken(code);
  if (!tokens.id_token) throw new Error('Google did not return an ID token');

  const ticket = await oauthClient.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new Error('Invalid Google ID token');

  return {
    sub: payload.sub,
    email: payload.email ?? null,
    emailVerified: !!payload.email_verified,
  };
}
