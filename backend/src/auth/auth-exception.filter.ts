import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { AuthRetryException } from './auth.errors';

@Catch()
export class AuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AuthExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (error instanceof AuthRetryException) response.setHeader('Retry-After', error.retryAfter);
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (error.getStatus() === 503 && !response.hasHeader('Retry-After')) response.setHeader('Retry-After', '5');
      response.status(error.getStatus()).json(typeof body === 'object' && 'error' in body ? body : {
        error: { code: 'AUTH_REQUEST_FAILED', message: 'Authentication request failed.' },
      });
      return;
    }
    // Do not log unknown exceptions: a driver may embed query values/secrets.
    this.logger.error('Unexpected authentication failure.');
    response.status(500).json({ error: { code: 'AUTH_INTERNAL_ERROR', message: 'Authentication failed.' } });
  }
}
