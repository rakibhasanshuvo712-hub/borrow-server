import type { ErrorRequestHandler, Request, Response, NextFunction, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';

export class AppError extends Error { constructor(public statusCode: number, message: string, public details?: unknown) { super(message); this.name = 'AppError'; } }

export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler => (req, res, next) => { void fn(req, res, next).catch(next); };

const reply = (res: Response, status: number, message: string, details?: unknown): void => {
  res.status(status).json({ success: false, message, ...(details !== undefined ? { errors: details } : {}) });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof AppError) return reply(res, error.statusCode, error.message, error.details);
  if (error instanceof ZodError) return reply(res, 400, 'Validation failed', error.flatten());
  if (error instanceof mongoose.Error.ValidationError) return reply(res, 400, 'Validation failed', Object.fromEntries(Object.entries(error.errors).map(([field, issue]) => [field, issue.message])));
  if (error instanceof mongoose.Error.CastError) return reply(res, 400, `Invalid value for ${error.path}`);
  if (error instanceof Error && error.name === 'MulterError') return reply(res, 400, error.message);
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000) return reply(res, 409, 'Duplicate entry');
  console.error('Unhandled request error:', error);
  reply(res, 500, 'Internal server error');
};
