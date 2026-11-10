import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { AppError, asyncHandler } from '../utils/errors.js';
export interface AuthUser { id: string; email: string; name: string; role: string; phone?: string; location?: string; bio?: string; isVerified?: boolean; trustScore?: number; canRent?: boolean; canList?: boolean }
declare global { namespace Express { interface Request { user?: AuthUser } } }
export const requireAuth: RequestHandler = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) throw new AppError(401, 'Authentication required');
  req.user = session.user as unknown as AuthUser; next();
});
export const requireRole = (...roles: string[]): RequestHandler => (req, _res, next) => { if (!req.user || !roles.includes(req.user.role)) return next(new AppError(403, 'Insufficient permissions')); next(); };
