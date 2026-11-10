import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { clientContext } from '../../common/http/client-context';
import { CatalogService } from './catalog.service';
import {
  CreateCategoryDto, CreateServiceDto, CreateStaffDto, ReorderCategoriesDto, UpdateCategoryDto, UpdateServiceDto, UpdateStaffDto,
} from './dto/catalog.dto';
import { PublicCatalogService } from './public-catalog.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });
const uuid = () => new ParseUUIDPipe();

type Upload = { buffer: Buffer; originalname?: string } | undefined;

/** Owner catalogue. The salon is ALWAYS the caller's own (derived from the session); no salon id is ever accepted. */
@ApiTags('catalog')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine')
export class OwnerCatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('catalog')
  async catalog(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.getCatalog(u) };
  }

  // ---- categories
  @Post('categories')
  @Throttle(limit(30))
  async createCategory(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateCategoryDto, @Req() req: Request) {
    return { data: await this.svc.createCategory(u, dto, clientContext(req)) };
  }

  @Put('categories/order')
  @Throttle(limit(30))
  async reorder(@CurrentUser() u: AuthenticatedUser, @Body() dto: ReorderCategoriesDto, @Req() req: Request) {
    return { data: await this.svc.reorderCategories(u, dto.ids, clientContext(req)) };
  }

  @Patch('categories/:id')
  @Throttle(limit(60))
  async updateCategory(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UpdateCategoryDto, @Req() req: Request) {
    return { data: await this.svc.updateCategory(u, id, dto, clientContext(req)) };
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @Throttle(limit(30))
  async deleteCategory(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.deleteCategory(u, id, clientContext(req));
  }

  @Put('categories/:id/image')
  @Throttle(limit(20))
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async setCategoryImage(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @UploadedFile() file: Upload, @Req() req: Request) {
    return { data: await this.svc.setImage(u, 'category', id, file, clientContext(req)) };
  }

  @Delete('categories/:id/image')
  @HttpCode(204)
  @Throttle(limit(30))
  async removeCategoryImage(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.removeImage(u, 'category', id, clientContext(req));
  }

  @Get('categories/:id/image/url')
  @Throttle(limit(120))
  async categoryImageUrl(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.imageUrl(u, 'category', id) };
  }

  // ---- services
  @Post('services')
  @Throttle(limit(60))
  async createService(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateServiceDto, @Req() req: Request) {
    return { data: await this.svc.createService(u, dto, clientContext(req)) };
  }

  @Patch('services/:id')
  @Throttle(limit(60))
  async updateService(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UpdateServiceDto, @Req() req: Request) {
    return { data: await this.svc.updateService(u, id, dto, clientContext(req)) };
  }

  @Delete('services/:id')
  @HttpCode(204)
  @Throttle(limit(30))
  async deleteService(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.deleteService(u, id, clientContext(req));
  }

  @Put('services/:id/image')
  @Throttle(limit(20))
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async setServiceImage(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @UploadedFile() file: Upload, @Req() req: Request) {
    return { data: await this.svc.setImage(u, 'service', id, file, clientContext(req)) };
  }

  @Delete('services/:id/image')
  @HttpCode(204)
  @Throttle(limit(30))
  async removeServiceImage(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.removeImage(u, 'service', id, clientContext(req));
  }

  @Get('services/:id/image/url')
  @Throttle(limit(120))
  async serviceImageUrl(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.imageUrl(u, 'service', id) };
  }

  // ---- staff roster (minimal in Phase 4; invitations, accounts, permissions and schedules arrive in Phase 5)
  @Post('staff')
  @Throttle(limit(30))
  async createStaff(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateStaffDto, @Req() req: Request) {
    return { data: await this.svc.createStaff(u, dto, clientContext(req)) };
  }

  @Patch('staff/:id')
  @Throttle(limit(60))
  async updateStaff(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UpdateStaffDto, @Req() req: Request) {
    return { data: await this.svc.updateStaff(u, id, dto, clientContext(req)) };
  }

  @Delete('staff/:id')
  @HttpCode(204)
  @Throttle(limit(30))
  async deleteStaff(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.deleteStaff(u, id, clientContext(req));
  }
}

@ApiTags('public')
@Public()
@Controller('public/salons')
export class PublicCatalogController {
  constructor(private readonly svc: PublicCatalogService) {}

  @Get(':id/catalog')
  @Throttle(limit(60))
  async catalog(@Param('id', uuid()) id: string) {
    return { data: await this.svc.catalog(id) };
  }
}
