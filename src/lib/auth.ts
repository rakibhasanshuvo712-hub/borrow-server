import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { MongoClient, ObjectId } from 'mongodb';
import { env } from '../config/env.js';

export const authMongoClient = new MongoClient(env.MONGODB_URI);
const db = authMongoClient.db();

/**
 * better-auth's MongoDB adapter persists `_id` as an ObjectId (and converts the
 * string `id` it hands out back to an ObjectId when it builds its own queries).
 * Direct driver queries must do the same conversion or they never match.
 */
export const toMongoId = (value: string): ObjectId => {
  try { return new ObjectId(value); } catch { return value as unknown as ObjectId; }
};
let authDatabaseReady: Promise<void> | undefined;
let authDatabaseConnected = false;
export async function connectAuthDatabase(): Promise<void> {
  if (authDatabaseConnected) return;
  authDatabaseReady ??= authMongoClient.connect().then(() => { authDatabaseConnected = true; }).catch(error => { authDatabaseReady = undefined; throw error; });
  await authDatabaseReady;
}
export const auth = betterAuth({
  database: mongodbAdapter(db), baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    env.FRONTEND_URL,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
  ].filter(Boolean), emailAndPassword: { enabled: true },
  user: { additionalFields: {
    role: { type: 'string', required: false, defaultValue: 'renter', input: false },
    phone: { type: 'string', required: false, input: true }, location: { type: 'string', required: false, input: true },
    bio: { type: 'string', required: false, input: true }, isVerified: { type: 'boolean', required: false, defaultValue: false, input: false },
    trustScore: { type: 'number', required: false, defaultValue: 50, input: false }, canRent: { type: 'boolean', required: false, defaultValue: true, input: false }, canList: { type: 'boolean', required: false, defaultValue: false, input: false },
    accountType: { type: 'string', required: false, defaultValue: 'renter', input: true }
  } },
  databaseHooks: { user: { create: { before: async user => {
    const rawAccountType = String(user.accountType || (user as { role?: string }).role || 'renter').toLowerCase();
    const accountType = ['renter', 'owner', 'both'].includes(rawAccountType) ? rawAccountType : 'renter';
    return { data: { ...user, accountType, role: accountType === 'renter' ? 'renter' : 'owner', canRent: accountType !== 'owner', canList: accountType !== 'renter' } };
  } } } },
  advanced: { useSecureCookies: env.NODE_ENV === 'production', defaultCookieAttributes: { sameSite: env.COOKIE_SAME_SITE, secure: env.NODE_ENV === 'production', httpOnly: true } }
});
