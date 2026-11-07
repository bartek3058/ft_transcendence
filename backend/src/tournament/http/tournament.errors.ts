import { HttpException } from '@nestjs/common';

/** Tournament error in the shared `{ error: { code, message } }` format. */
export class TournamentHttpError extends HttpException {
  constructor(status: number, code: string, message: string, readonly retryAfter?: number) {
    super({ error: { code, message } }, status);
  }
}
