import { HttpException, ServiceUnavailableException } from '@nestjs/common';

export function storageUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({ error: {
    code: 'AUTH_STORAGE_UNAVAILABLE', message: 'Account storage is temporarily unavailable.',
  } });
}

export class AuthRetryException extends HttpException {
  constructor(status: number, code: string, message: string, readonly retryAfter: number) {
    super({ error: { code, message } }, status);
  }
}
