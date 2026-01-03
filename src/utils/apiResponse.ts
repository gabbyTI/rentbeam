import { PaginationResult } from './pagination.js';

/**
 * Standard success response format for API endpoints
 * Ensures consistent response structure across all endpoints
 */

interface ApiSuccessResponse<T = any> {
  status: 'success';
  data?: T;
  message?: string;
  pagination?: PaginationResult;
}

/**
 * Creates a standardized success response
 * 
 * @param data - The response data
 * @param message - Optional success message
 * @param pagination - Optional pagination metadata
 * @returns Formatted API response
 * 
 * @example
 * // Simple data response
 * res.json(apiResponse(properties));
 * // { status: 'success', data: [...] }
 * 
 * @example
 * // With pagination
 * res.json(apiResponse(properties, null, pagination));
 * // { status: 'success', data: [...], pagination: {...} }
 * 
 * @example
 * // With custom message
 * res.status(201).json(apiResponse(newProperty, 'Property created successfully'));
 * // { status: 'success', data: {...}, message: 'Property created successfully' }
 */
export function apiResponse<T = any>(
  data?: T,
  message?: string | null,
  pagination?: PaginationResult
): ApiSuccessResponse<T> {
  const response: ApiSuccessResponse<T> = {
    status: 'success',
  };

  if (data !== undefined) {
    response.data = data;
  }

  if (message) {
    response.message = message;
  }

  if (pagination) {
    response.pagination = pagination;
  }

  return response;
}
