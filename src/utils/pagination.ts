import { Request } from 'express';

export interface PaginationOptions {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginationResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SortOptions {
  orderBy: Record<string, 'asc' | 'desc'>[];
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Parses pagination parameters from query string
 * 
 * @param query - Express request query object
 * @returns Pagination options for Prisma
 * 
 * @example
 * const { page, limit, skip } = parsePagination(req.query);
 * await prisma.property.findMany({ take: limit, skip });
 */
export function parsePagination(query: Request['query']): PaginationOptions {
  const page = Math.max(1, parseInt(query.page as string) || DEFAULT_PAGE);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(query.limit as string) || DEFAULT_LIMIT)
  );
  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

/**
 * Parses sort parameters from query string
 * Supports multiple sort fields separated by comma
 * Use - prefix for descending order
 * 
 * @param query - Express request query object
 * @param defaultSort - Default sort field if none provided
 * @returns Sort options for Prisma
 * 
 * @example
 * // ?sort=-createdAt,name
 * const sort = parseSort(req.query, '-createdAt');
 * // Returns: { orderBy: [{ createdAt: 'desc' }, { name: 'asc' }] }
 */
export function parseSort(
  query: Request['query'],
  defaultSort: string = '-createdAt'
): SortOptions {
  const sortString = (query.sort as string) || defaultSort;
  const sortFields = sortString.split(',');

  const orderBy = sortFields.map((field) => {
    const isDescending = field.startsWith('-');
    const fieldName = isDescending ? field.slice(1) : field;
    return { [fieldName]: isDescending ? 'desc' : 'asc' } as Record<string, 'asc' | 'desc'>;
  });

  return { orderBy };
}

/**
 * Builds pagination metadata for API response
 * 
 * @param page - Current page number
 * @param limit - Items per page
 * @param total - Total number of items
 * @returns Pagination metadata
 * 
 * @example
 * const total = await prisma.property.count({ where });
 * const pagination = buildPaginationResult(page, limit, total);
 */
export function buildPaginationResult(
  page: number,
  limit: number,
  total: number
): PaginationResult {
  const totalPages = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    totalPages,
  };
}
