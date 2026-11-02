import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import {
  ApiKeyMessageResponseDto,
  ApiKeySummaryDto,
  CreatedApiKeyDto,
} from './dto/api-key-response.dto';
import { AuthenticatedRequest, SessionGuard } from '../../auth/session.guard';
import { AuthRequestGuard } from '../../auth/auth-request.guard';

@ApiTags('User API Keys')
@UseGuards(SessionGuard, AuthRequestGuard)
@Controller('user/api-keys')
export class UserApiKeysController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  @ApiOperation({
    summary: 'Generate a new API key for the authenticated web user',
    description: 'Generates a new API key for the current session user. The raw key is returned ONLY once.',
  })
  @ApiResponse({ status: 201, description: 'API key successfully created', type: CreatedApiKeyDto })
  @ApiResponse({ status: 400, description: 'Invalid name or expiration' })
  @ApiResponse({ status: 401, description: 'Unauthorized — requires valid session cookie' })
  async createKey(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyDto> {
    const expiresAt = dto.expiresInDays
      ? new Date(Date.now() + dto.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const result = await this.apiKeyService.createApiKey(
      request.account.id,
      dto.name,
      expiresAt,
    );

    return {
      id: result.id,
      name: result.name,
      keyPrefix: result.keyPrefix,
      apiKey: result.rawKey,
      lastUsedAt: null,
      expiresAt: result.expiresAt,
      revokedAt: null,
      createdAt: result.createdAt,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'List API keys owned by the authenticated web user',
    description: 'Returns safe metadata for all API keys created by the current session user.',
  })
  @ApiResponse({ status: 200, description: 'List of API keys', type: [ApiKeySummaryDto] })
  @ApiResponse({ status: 401, description: 'Unauthorized — requires valid session cookie' })
  async listKeys(@Req() request: AuthenticatedRequest): Promise<ApiKeySummaryDto[]> {
    return this.apiKeyService.listUserKeys({
      id: request.account.id,
      role: 'user',
    });
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Revoke an API key owned by the authenticated web user',
    description: 'Soft-revokes an API key owned by the caller. Future requests using this key will be rejected.',
  })
  @ApiResponse({ status: 200, description: 'Revocation confirmation', type: ApiKeyMessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid UUID format' })
  @ApiResponse({ status: 401, description: 'Unauthorized — requires valid session cookie' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async deleteKey(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ApiKeyMessageResponseDto> {
    return this.apiKeyService.deleteApiKey(id, false, {
      id: request.account.id,
      role: 'user',
    });
  }
}
