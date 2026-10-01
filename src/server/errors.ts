export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'BAD_REQUEST',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
