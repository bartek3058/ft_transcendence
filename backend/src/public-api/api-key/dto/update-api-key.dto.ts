import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateApiKeyDto {
  @ApiPropertyOptional({ description: 'Updated name for the API key', example: 'Renamed Key' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;
}
