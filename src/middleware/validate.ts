import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../utils/errors.js';
export const validateBody = (schema: ZodType): RequestHandler => (req, _res, next) => { const result = schema.safeParse(req.body); if (!result.success) return next(new AppError(400, 'Invalid request body', result.error.flatten())); req.body = result.data as unknown; next(); };
