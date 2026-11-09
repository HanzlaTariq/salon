export interface AuditEntry {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  salonId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** Never put passwords, tokens, OTPs or other secrets here. */
  metadata?: Record<string, unknown> | null;
}

export interface AuditRow extends AuditEntry {
  id: string;
  createdAt: Date;
}

/** Minimal SQL surface shared by PrismaService and interactive-transaction clients. */
export interface SqlClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export async function insertAudit(db: Pick<SqlClient, '$executeRaw'>, e: AuditEntry): Promise<void> {
  const metadata = e.metadata ? JSON.stringify(e.metadata) : null;
  await db.$executeRaw`
    INSERT INTO audit_logs (actor_user_id, actor_role, action, target_type, target_id, salon_id,
                            ip_address, user_agent, request_id, metadata)
    VALUES (${e.actorUserId ?? null}::uuid, ${e.actorRole ?? null}::varchar, ${e.action}::varchar,
            ${e.targetType ?? null}::varchar, ${e.targetId ?? null}::varchar, ${e.salonId ?? null}::uuid,
            ${e.ipAddress ?? null}::varchar, ${e.userAgent ?? null}::varchar, ${e.requestId ?? null}::varchar,
            ${metadata}::jsonb)`;
}
