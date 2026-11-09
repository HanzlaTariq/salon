import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditEntry, AuditRow, SqlClient, insertAudit } from './audit.types';

interface RawAuditRow {
  id: string;
  created_at: Date;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  salon_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly db: SqlClient;

  constructor(prisma: PrismaService) {
    this.db = prisma as unknown as SqlClient;
  }

  /** For events that MUST be recorded (fails the caller if the audit write fails). */
  record(entry: AuditEntry): Promise<void> {
    return insertAudit(this.db, entry);
  }

  /** For high-volume security telemetry (e.g. failed logins): never breaks the request. */
  async recordSafe(entry: AuditEntry): Promise<void> {
    try {
      await insertAudit(this.db, entry);
    } catch (err) {
      this.logger.error({ err, action: entry.action }, 'Failed to write audit log');
    }
  }

  async list(f: { action?: string; actorUserId?: string; limit: number; offset: number }): Promise<AuditRow[]> {
    const rows = await this.db.$queryRaw<RawAuditRow[]>`
      SELECT * FROM audit_logs
      WHERE (${f.action ?? null}::varchar IS NULL OR action = ${f.action ?? null}::varchar)
        AND (${f.actorUserId ?? null}::uuid IS NULL OR actor_user_id = ${f.actorUserId ?? null}::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      actorUserId: r.actor_user_id,
      actorRole: r.actor_role,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      salonId: r.salon_id,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      requestId: r.request_id,
      metadata: r.metadata,
    }));
  }
}
