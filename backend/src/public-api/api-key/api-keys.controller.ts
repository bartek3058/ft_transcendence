import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import {
  ApiKeyMessageResponseDto,
  ApiKeySummaryDto,
  CreatedApiKeyDto,
} from './dto/api-key-response.dto';
import { ApiKeyGuard, PublicApiRequest } from '../common/api-key.guard';
import { PublicApiExceptionFilter } from '../common/public-api-exception.filter';

@ApiTags('API Keys')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@UseFilters(PublicApiExceptionFilter)
@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a new API key',
    description: 'Generates a new secured API key. The raw key is returned ONLY once in this response.',
  })
  @ApiResponse({ status: 201, description: 'API key successfully created', type: CreatedApiKeyDto })
  @ApiResponse({ status: 400, description: 'Invalid name or expiration' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async createKey(
    @Req() request: PublicApiRequest,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyDto> {
    const caller = request.apiKeyUser!;
    const expiresAt = dto.expiresInDays
      ? new Date(Date.now() + dto.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const result = await this.apiKeyService.createApiKey(caller.id, dto.name, expiresAt);
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
    summary: 'List API keys',
    description: 'Lists API keys belonging to the authenticated caller (or all keys if caller is an admin).',
  })
  @ApiResponse({ status: 200, description: 'List of API keys', type: [ApiKeySummaryDto] })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listKeys(@Req() request: PublicApiRequest): Promise<ApiKeySummaryDto[]> {
    return this.apiKeyService.listUserKeys(request.apiKeyUser!);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get API key by ID',
    description: 'Retrieves metadata for a specific API key.',
  })
  @ApiResponse({ status: 200, description: 'API key metadata', type: ApiKeySummaryDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async getKey(
    @Req() request: PublicApiRequest,
    @Param('id') id: string,
  ): Promise<ApiKeySummaryDto> {
    return this.apiKeyService.getKeyById(id, request.apiKeyUser!);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update API key metadata',
    description: 'Updates the human-readable label of an existing API key.',
  })
  @ApiResponse({ status: 200, description: 'Updated API key metadata', type: ApiKeySummaryDto })
  @ApiResponse({ status: 400, description: 'Invalid key name' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async updateKey(
    @Req() request: PublicApiRequest,
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyDto,
  ): Promise<ApiKeySummaryDto> {
    return this.apiKeyService.updateApiKey(id, dto.name, request.apiKeyUser!);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Revoke or delete an API key',
    description: 'Revokes an API key. Admins can optionally pass ?purge=true to permanently delete unused or expired keys.',
  })
  @ApiQuery({ name: 'purge', required: false, type: Boolean, description: 'Permanently remove from database (admin only)' })
  @ApiResponse({ status: 200, description: 'Revocation / deletion confirmation', type: ApiKeyMessageResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async deleteKey(
    @Req() request: PublicApiRequest,
    @Param('id') id: string,
    @Query('purge') purge?: string,
  ): Promise<ApiKeyMessageResponseDto> {
    const isPurge = purge === 'true' || purge === '1';
    return this.apiKeyService.deleteApiKey(id, isPurge, request.apiKeyUser!);
  }
}
