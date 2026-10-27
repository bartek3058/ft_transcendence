import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateApiKeyDto {
  @ApiProperty({ description: 'Human-readable name for the key', example: 'Evaluator Test Key' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional({ description: 'Optional lifetime in days (1 to 365)', example: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
