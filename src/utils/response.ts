import type { Response } from 'express';
export function send<T>(res: Response, data: T, message = 'OK', status = 200, meta?: Record<string, unknown>): void { res.status(status).json({ success: true, data, message, ...(meta ? { meta } : {}) }); }
