import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors.js';
import { handlePrismaError } from '../utils/prismaErrorHandler.js';
import logger from '../lib/logger.js';

/**
 * Sends error response in development environment
 * Includes full error details and stack trace for debugging
 */
const sendErrorDev = (err: AppError, req: Request, res: Response) => {
  logger.error({
    err,
    req: {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    },
  }, 'Error occurred');

  res.status(err.statusCode).json({
    status: err.status,
    message: err.message,
    error: err,
    stack: err.stack,
  });
};

/**
 * Sends error response in production environment
 * Only exposes safe, operational errors to clients
 */
const sendErrorProd = (err: AppError, req: Request, res: Response) => {
  // Operational, trusted error - safe to send to client
  if (err.isOperational) {
    logger.warn({
      err: {
        message: err.message,
        statusCode: err.statusCode,
        status: err.status,
      },
      req: {
        method: req.method,
        url: req.url,
        ip: req.ip,
      },
    }, 'Operational error');

    return res.status(err.statusCode).json({
      status: err.status,
      statusCode: err.statusCode,
      message: err.message,
    });
  }

  // Programming or unknown error - don't leak details
  logger.error({
    err,
    req: {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    },
  }, 'Unexpected error');

  res.status(500).json({
    status: 'error',
    statusCode: 500,
    message: 'Something went wrong',
  });
};

/**
 * Global error handler middleware
 * Transforms database errors, logs appropriately, and sends formatted responses
 */
export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let error = err;

  // Set defaults
  error.statusCode = error.statusCode || 500;
  error.status = error.status || 'error';

  // Transform Prisma errors into AppError (only if it's actually a Prisma error)
  if (error.name === 'PrismaClientKnownRequestError' || 
      error.name === 'PrismaClientValidationError' ||
      (error.code && error.code.startsWith && error.code.startsWith('P') && error.clientVersion)) {
    error = handlePrismaError(error);
  }

  // Send appropriate response based on environment
  if (process.env.NODE_ENV === 'development') {
    sendErrorDev(error, req, res);
  } else {
    sendErrorProd(error, req, res);
  }
};
