import { Module } from '@nestjs/common';
import { SalonsModule } from '../salons/salons.module';
import { InvitationMailer } from './invitation-mailer';
import { InvitationService } from './invitation.service';
import { OwnerTeamController, PublicInvitationController, StaffSelfController } from './staff.controllers';
import { StaffRepository } from './staff.repository';
import { StaffSelfService } from './staff-self.service';
import { TeamService } from './team.service';

/**
 * Phase 5: staff management. Depends on AuthModule (global: AuthRepository, TokenService, PasswordService,
 * Mailer) and SalonsModule (salon lookup, opening hours). No file uploads, so no multer setup here.
 */
@Module({
  imports: [SalonsModule],
  controllers: [OwnerTeamController, StaffSelfController, PublicInvitationController],
  providers: [StaffRepository, TeamService, StaffSelfService, InvitationService, InvitationMailer],
})
export class StaffModule {}
