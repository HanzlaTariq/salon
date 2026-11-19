import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { SalonsModule } from '../salons/salons.module';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AnalyticsRepository } from './analytics.repository';
import { ExpensesService } from './expenses.service';
import { AdminAnalyticsController, OwnerExpensesController, OwnerReportsController, StaffReportsController } from './reports.controllers';
import { ReportsRepository } from './reports.repository';
import { SalonReportsService } from './salon-reports.service';

/**
 * Phase 13: reports and analytics. Read-only over the data of earlier phases, plus the salon's own expenses.
 * Imports SalonsModule (salon lookup) and BillingModule (the SAME subscription overview numbers the billing screens show, so the
 * analytics page and the billing page can never disagree). Nothing in booking, billing or sync was changed to make this work.
 */
@Module({
  imports: [SalonsModule, BillingModule],
  controllers: [OwnerReportsController, OwnerExpensesController, StaffReportsController, AdminAnalyticsController],
  providers: [ReportsRepository, AnalyticsRepository, SalonReportsService, ExpensesService, AdminAnalyticsService],
})
export class ReportsModule {}
