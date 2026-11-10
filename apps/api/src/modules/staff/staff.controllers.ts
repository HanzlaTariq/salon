import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { clientContext } from '../../common/http/client-context';
import { InvitationService } from './invitation.service';
import {
  AcceptInvitationDto, BreaksDto, CreateStaffMemberDto, LeaveDecisionDto, LeaveDto, PreviewInvitationDto, SendInvitationDto,
  UpdateStaffMemberDto, WeeklyHoursDto,
} from './dto/staff.dto';
import { StaffSelfService } from './staff-self.service';
import { TeamService } from './team.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });
const uuid = () => new ParseUUIDPipe();

/** Owner team management. The salon is always the caller's own; no salon id is accepted. */
@ApiTags('team')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine/team')
export class OwnerTeamController {
  constructor(private readonly svc: TeamService) {}

  @Get()
  @Throttle(limit(120))
  async list(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.list(u) };
  }

  @Post()
  @Throttle(limit(30))
  async create(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateStaffMemberDto, @Req() req: Request) {
    return { data: await this.svc.create(u, dto, clientContext(req)) };
  }

  @Get(':id')
  @Throttle(limit(120))
  async get(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return { data: await this.svc.get(u, id) };
  }

  @Patch(':id')
  @Throttle(limit(60))
  async update(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UpdateStaffMemberDto, @Req() req: Request) {
    return { data: await this.svc.update(u, id, dto, clientContext(req)) };
  }

  @Delete(':id')
  @HttpCode(204)
  @Throttle(limit(30))
  async remove(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    await this.svc.remove(u, id, clientContext(req));
  }

  @Post(':id/invitation')
  @Throttle(limit(10))
  async invite(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: SendInvitationDto, @Req() req: Request) {
    return { data: await this.svc.invite(u, id, dto, clientContext(req)) };
  }

  @Delete('invitations/:inviteId')
  @HttpCode(204)
  @Throttle(limit(30))
  async revokeInvitation(@CurrentUser() u: AuthenticatedUser, @Param('inviteId', uuid()) inviteId: string, @Req() req: Request) {
    await this.svc.revokeInvitation(u, inviteId, clientContext(req));
  }

  @Put(':id/working-hours')
  @Throttle(limit(60))
  async setHours(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: WeeklyHoursDto, @Req() req: Request) {
    return { data: await this.svc.setWorkingHours(u, id, dto, clientContext(req)) };
  }

  @Put(':id/breaks')
  @Throttle(limit(60))
  async setBreaks(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: BreaksDto, @Req() req: Request) {
    return { data: await this.svc.setBreaks(u, id, dto, clientContext(req)) };
  }

  @Post(':id/leaves')
  @Throttle(limit(30))
  async recordLeave(@CurrentUser() u: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: LeaveDto, @Req() req: Request) {
    return { data: await this.svc.recordLeave(u, id, dto, clientContext(req)) };
  }

  @Delete(':id/leaves/:leaveId')
  @HttpCode(204)
  @Throttle(limit(30))
  async cancelLeave(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Param('leaveId', uuid()) leaveId: string,
    @Req() req: Request,
  ) {
    await this.svc.cancelLeave(u, id, leaveId, clientContext(req));
  }

  @Patch('leaves/:leaveId')
  @Throttle(limit(60))
  async reviewLeave(@CurrentUser() u: AuthenticatedUser, @Param('leaveId', uuid()) leaveId: string, @Body() dto: LeaveDecisionDto, @Req() req: Request) {
    return { data: await this.svc.reviewLeave(u, leaveId, dto, clientContext(req)) };
  }
}

/** Staff self-service. SALON_STAFF only; every response is the caller's own data. */
@ApiTags('staff')
@ApiBearerAuth()
@Roles('SALON_STAFF')
@Controller('staff/me')
export class StaffSelfController {
  constructor(private readonly svc: StaffSelfService) {}

  @Get()
  @Throttle(limit(120))
  async me(@CurrentUser() u: AuthenticatedUser) {
    return { data: await this.svc.me(u) };
  }

  @Put('breaks')
  @Throttle(limit(60))
  async setBreaks(@CurrentUser() u: AuthenticatedUser, @Body() dto: BreaksDto, @Req() req: Request) {
    return { data: await this.svc.replaceBreaks(u, dto, clientContext(req)) };
  }

  @Post('leaves')
  @Throttle(limit(30))
  async requestLeave(@CurrentUser() u: AuthenticatedUser, @Body() dto: LeaveDto, @Req() req: Request) {
    return { data: await this.svc.requestLeave(u, dto, clientContext(req)) };
  }

  @Delete('leaves/:leaveId')
  @HttpCode(204)
  @Throttle(limit(30))
  async cancelLeave(@CurrentUser() u: AuthenticatedUser, @Param('leaveId', uuid()) leaveId: string, @Req() req: Request) {
    await this.svc.cancelLeaveRequest(u, leaveId, clientContext(req));
  }
}

/**
 * Public invitation endpoints. The token is sent in the JSON body (never in the URL path, so it stays out of
 * access logs). Rate limited per IP.
 */
@ApiTags('public')
@Public()
@Controller('public/staff-invitations')
export class PublicInvitationController {
  constructor(private readonly svc: InvitationService) {}

  @Post('preview')
  @HttpCode(200)
  @Throttle(limit(20))
  async preview(@Body() dto: PreviewInvitationDto) {
    return { data: await this.svc.preview(dto) };
  }

  @Post('accept')
  @Throttle(limit(10))
  async accept(@Body() dto: AcceptInvitationDto, @Req() req: Request) {
    return { data: await this.svc.accept(dto, clientContext(req)) };
  }
}
