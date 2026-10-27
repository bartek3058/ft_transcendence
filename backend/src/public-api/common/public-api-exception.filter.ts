import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { PublicApiRetryException } from './public-api.errors';

@Catch()
export class PublicApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicApiExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');

    if (error instanceof PublicApiRetryException) {
      response.setHeader('Retry-After', error.retryAfter.toString());
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      if ((status === 429 || status === 503) && !response.hasHeader('Retry-After')) {
        response.setHeader('Retry-After', '60');
      }
      const body = error.getResponse();
      response.status(status).json(
        typeof body === 'object' && body !== null && 'error' in body
          ? body
          : { error: { code: 'PUBLIC_API_ERROR', message: error.message } },
      );
      return;
    }

    // Do not leak stack traces or database driver specifics to external clients
    this.logger.error('Unhandled Public API error:', error instanceof Error ? error.message : error);
    response.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An internal server error occurred.' },
    });
  }
}
