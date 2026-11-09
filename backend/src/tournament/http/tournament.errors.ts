import { HttpException } from '@nestjs/common';

export class TournamentHttpError extends HttpException {
  constructor(status: number, code: string, message: string, readonly retryAfter?: number) {
    super({ error: { code, message } }, status);
  }
}
