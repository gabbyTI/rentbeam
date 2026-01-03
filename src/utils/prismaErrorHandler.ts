import { Prisma } from '@prisma/client';
import { AppError, ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';

/**
 * Transforms Prisma errors into user-friendly AppError instances
 * 
 * Common Prisma error codes:
 * - P2002: Unique constraint violation
 * - P2003: Foreign key constraint violation
 * - P2025: Record not found
 * - P2014: Required relation violation
 * - P2021: Table does not exist
 * - P2022: Column does not exist
 */
export function handlePrismaError(error: any): AppError {
  // Unique constraint violation (duplicate key)
  if (error.code === 'P2002') {
    const fields = error.meta?.target || [];
    const fieldNames = Array.isArray(fields) ? fields.join(', ') : 'field';
    return new ConflictError(`${fieldNames} already exists`);
  }

  // Foreign key constraint failed
  if (error.code === 'P2003') {
    const field = error.meta?.field_name || 'reference';
    return new ValidationError(`Invalid ${field} - referenced record does not exist`);
  }

  // Record not found (findUniqueOrThrow, etc.)
  if (error.code === 'P2025') {
    return new NotFoundError('Record not found');
  }

  // Required relation violation
  if (error.code === 'P2014') {
    return new ValidationError('Required relation is missing');
  }

  // Connection errors
  if (error.code === 'P1001' || error.code === 'P1002' || error.code === 'P1003') {
    return new AppError('Database connection error', 503);
  }

  // Table does not exist
  if (error.code === 'P2021') {
    return new AppError('Database schema error', 500);
  }

  // Column does not exist
  if (error.code === 'P2022') {
    return new AppError('Database schema error', 500);
  }

  // Query validation error
  if (error instanceof Prisma.PrismaClientValidationError) {
    return new ValidationError('Invalid query parameters');
  }

  // Generic Prisma error
  return new AppError('Database operation failed', 500);
}
