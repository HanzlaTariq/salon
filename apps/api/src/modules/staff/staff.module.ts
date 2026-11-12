import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { SalonsModule } from '../salons/salons.module';
import { InvitationMailer } from './invitation-mailer';
import { InvitationService } from './invitation.service';
import { OwnerTeamController, PublicInvitationController, StaffSelfController } from './staff.controllers';
import { StaffRepository } from './staff.repository';
import { StaffSelfService } from './staff-self.service';
import { TeamService } from './team.service';

/**
 * Phase 5: staff management. Phase 6: imports BillingModule (BillingCore.reconcile after every billable change). Depends on AuthModule (global: AuthRepository, TokenService, PasswordService,
 * Mailer) and SalonsModule (salon lookup, opening hours). No file uploads, so no multer setup here.
 */
@Module({
  imports: [SalonsModule, BillingModule],
  controllers: [OwnerTeamController, StaffSelfController, PublicInvitationController],
  providers: [StaffRepository, TeamService, StaffSelfService, InvitationService, InvitationMailer],
})
export class StaffModule {}
