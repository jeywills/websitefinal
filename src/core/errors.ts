export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}

export const errors = {
  invalid: (message: string, details?: unknown) => new ApiError(400, 'invalid_request', message, details),
  unauthorized: (message = 'Missing or invalid API key') => new ApiError(401, 'unauthorized', message),
  forbidden: (message: string) => new ApiError(403, 'forbidden', message),
  notFound: (what: string) => new ApiError(404, 'not_found', `${what} not found`),
  invalidState: (message: string, details?: unknown) => new ApiError(409, 'invalid_state', message, details),
  conflict: (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details),
  unprocessable: (code: string, message: string, details?: unknown) => new ApiError(422, code, message, details),
  mandateBudget: (message: string, details: unknown) => new ApiError(402, 'mandate_budget_exceeded', message, details),
  mandateScope: (message: string, details: unknown) => new ApiError(403, 'mandate_scope_violation', message, details),
  mandateInactive: (message: string) => new ApiError(403, 'mandate_inactive', message),
};
