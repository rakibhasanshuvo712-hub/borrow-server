import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(5000), NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().min(1), BETTER_AUTH_SECRET: z.string().min(32), BETTER_AUTH_URL: z.string().url(), FRONTEND_URL: z.string().url(),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'), CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(), CLOUDINARY_API_KEY: z.string().min(1).optional(), CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
});
const result = schema.safeParse(process.env);
if (!result.success) throw new Error(`Invalid environment configuration: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
export const env = result.data;
