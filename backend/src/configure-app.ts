import { BadRequestException, HttpException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, Request, Response, NextFunction } from 'express';
import { AuthValidationPipe } from './auth/validation/auth-validation.pipe';

// Factory must use { bodyParser: false } so this is the only JSON parser.
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api');
  app.use('/api/auth', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      const error = new UnsupportedMediaTypeException({ error: {
        code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use application/json.',
      } });
      res.status(error.getStatus()).json(error.getResponse());
      return;
    }
    next();
  });
  app.use(json({ limit: '16kb', strict: true }));
  app.use((error: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    let response: HttpException;
    if (error.type === 'entity.too.large') {
      response = new PayloadTooLargeException({ error: {
        code: 'PAYLOAD_TOO_LARGE', message: 'JSON body exceeds 16 KiB.',
      } });
    } else if (error.type === 'entity.parse.failed') {
      response = new BadRequestException({ error: {
        code: 'INVALID_JSON', message: 'Body must be a valid JSON object.',
      } });
    } else {
      next(error);
      return;
    }
    res.status(response.getStatus()).json(response.getResponse());
  });
  app.useGlobalPipes(new AuthValidationPipe());
  // Frontend and API are behind the same Nginx origin: no permissive CORS.
}
