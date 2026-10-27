import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiKeySummaryDto {
  @ApiProperty({ example: 'b83d1c4a-6d1f-4b0d-9e23-7fa34bb59e01' })
  id: string;

  @ApiProperty({ example: 'Evaluator Test Key' })
  name: string;

  @ApiProperty({ example: 'tr_live_a8f9c2d4' })
  keyPrefix: string;

  @ApiPropertyOptional({ example: '2026-10-27T14:30:00.000Z' })
  lastUsedAt: Date | null;

  @ApiPropertyOptional({ example: null })
  expiresAt: Date | null;

  @ApiPropertyOptional({ example: null })
  revokedAt: Date | null;

  @ApiProperty({ example: '2026-10-27T14:00:00.000Z' })
  createdAt: Date;
}

export class CreatedApiKeyDto extends ApiKeySummaryDto {
  @ApiProperty({
    example: 'tr_live_a8f9c2d4e6f80123456789abcdef0123456789abcdef0123456789abcdef01',
    description: 'The raw secret API key. Store this safely: it is displayed only once and cannot be retrieved again.',
  })
  apiKey: string;
}

export class ApiKeyMessageResponseDto {
  @ApiProperty({ example: 'API key revoked successfully.' })
  message: string;
}
