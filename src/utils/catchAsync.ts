import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.js';

/**
 * Wraps async route handlers to catch errors and pass them to Express error handler
 * Eliminates the need for try-catch blocks in every route
 * 
 * @example
 * router.get('/', catchAsync(async (req, res) => {
 *   const data = await prisma.findMany();
 *   res.json(apiResponse(data));
 * }));
 */
type AsyncRequestHandler = (
  req: AuthRequest | Request,
  res: Response,
  next: NextFunction
) => Promise<any>;

export const catchAsync = (fn: AsyncRequestHandler) => {
  return (req: Request | AuthRequest, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
};
